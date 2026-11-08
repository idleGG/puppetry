import { createHmac, timingSafeEqual } from 'node:crypto'
import qrcode from './vendor/qrcode.cjs'
import { openBase, sealAuth } from './crypto/hpke.js'
import {
  controllerIdFromPublic,
  identityKeys,
  signBytes,
  verifyBytes,
} from './keys.js'
import { bindingPayload, signBindingPayload } from './protocol.js'
import {
  b64u,
  randomToken,
  sha256,
  stableStringify,
  unb64u,
  uuid,
} from './util.js'

const PAIR_TTL_MS = 5 * 60 * 1000
const DEFAULT_SCOPES = [
  'presence',
  'session.list',
  'session.read',
  'session.prompt',
  'session.cancel',
  'session.organize',
  'session.create',
  'env.read',
  'approval.respond',
]

/**
 * Controller-initiated QR pairing.
 *
 * The agent shows a QR containing its public keys plus a one-time PSK. The
 * controller scans it and submits an HPKE-sealed invitation to the relay; the
 * relay only queues the ciphertext. On the next heartbeat the agent opens the
 * invitation, verifies the PSK proof and controller signature, creates the
 * binding, and returns an HPKE-sealed result that the controller polls for.
 */
export class PairingManager {
  constructor({ store, agent, log }) {
    this.store = store
    this.agent = agent
    this.log = log
    this.active = null
    this.lastResult = null
  }

  get identity() {
    return this.store.identity
  }

  allowedScopes() {
    const scopes = new Set(DEFAULT_SCOPES)
    if (this.store.config.allowRemoteProjectCreate) scopes.add('project.create')
    return scopes
  }

  status() {
    if (!this.active) return { active: false, pairings: this.store.bindings.length }
    return {
      active: this.active.expiresAt > Date.now(),
      pairing_id: this.active.pairingId,
      expires_at: new Date(this.active.expiresAt).toISOString(),
      last_result: this.lastResult,
    }
  }

  async create() {
    if (!this.store.config.relayUrl) throw new Error('set the relay URL before creating a QR code')
    this.gc()
    if (this.active && this.active.expiresAt > Date.now()) return this.describe(this.active)

    const pairingId = `pr_${randomToken(12)}`
    const psk = randomToken(32)
    const expiresAt = Date.now() + PAIR_TTL_MS
    const pskBytes = unb64u(psk)
    const commit = b64u(sha256(pskBytes))
    const body = {
      v: 1,
      pairing_id: pairingId,
      agent_id: this.agent.agentId,
      agent_ed: this.identity.ed.pub,
      agent_x: this.identity.x.pub,
      agent_name: this.store.config.agentName,
      psk_commit: commit,
      exp: expiresAt,
      mode: 'qr-invite',
    }
    await this.agent.request('POST', '/v1/pairings', body)

    const offer = {
      v: 1,
      relay: this.store.config.relayUrl,
      pid: pairingId,
      psk,
      agent_id: this.agent.agentId,
      agent_ed: this.identity.ed.pub,
      agent_x: this.identity.x.pub,
      name: this.store.config.agentName,
      exp: expiresAt,
    }
    // One canonical message, two carriers: the QR URI wraps the same token the
    // copy form shows. `payload` is the base64url canonical JSON of `offer`.
    const payload = b64u(Buffer.from(stableStringify(offer), 'utf8'))
    const uri = `puppetry://pair?t=${payload}`
    const token = `puppetry1:pair:${payload}`
    const qr = qrcode(0, 'M')
    qr.addData(uri, 'Byte')
    qr.make()
    const svg = qr.createSvgTag({ cellSize: 4, margin: 4, scalable: true })
    this.active = { pairingId, psk, pskCommit: commit, expiresAt, uri, token, payload, offer, svg, createdAt: Date.now() }
    this.lastResult = null
    this.store.audit('pairing-created', { pairingId, expiresAt })
    this.log.info(`[dsh-puppet] pairing window opened: ${pairingId}`)
    return this.describe(this.active)
  }

  describe(active) {
    return {
      pairing_id: active.pairingId,
      uri: active.uri,
      token: active.token,
      svg: active.svg,
      expires_at: new Date(active.expiresAt).toISOString(),
      expires_in_ms: Math.max(0, active.expiresAt - Date.now()),
    }
  }

  async cancel() {
    const active = this.active
    this.active = null
    if (active) {
      try {
        await this.agent.request('POST', `/v1/pairings/${encodeURIComponent(active.pairingId)}/cancel`, {})
      } catch {
        // Server-side cancellation is best effort; the QR also expires.
      }
      this.store.audit('pairing-cancelled', { pairingId: active.pairingId })
    }
    return { ok: true }
  }

  gc() {
    if (this.active && this.active.expiresAt <= Date.now()) {
      this.store.audit('pairing-expired', { pairingId: this.active.pairingId })
      this.active = null
    }
  }

  async handleInvitations(items) {
    if (!Array.isArray(items) || items.length === 0) return 0
    this.gc()
    let processed = 0
    for (const item of items) {
      const pairingId = item.pairing_id ?? item.pairingId
      if (!this.active || this.active.pairingId !== pairingId) {
        this.log.warn(`[dsh-puppet] pairing invitation for unknown/expired window: ${pairingId}`)
        continue
      }
      try {
        const invitation = this.openInvitation(item.envelope, this.active)
        const record = await this.bind(invitation, this.active)
        // 服务端需要一份绑定副本才能做粗粒度 ACL / presence 路由（identity-pairing.md §1.4）。登记是
        // 幂等的；失败不阻断绑定结果（控制端配对成功路径也会再登记一次作为兜底）。
        try {
          await this.agent.request('POST', '/v1/bindings', {
            binding_id: record.binding_id,
            agent_id: record.agent_id,
            agent_ed: record.agent_ed,
            controller_id: record.controller_id,
            controller_ed: record.controller_ed,
            scopes: record.scopes,
            agent_sig: record.agent_sig,
            controller_sig: record.controller_sig,
          })
        } catch (error) {
          this.log.warn(`[dsh-puppet] pairing registration failed (controller may retry): ${error.message}`)
        }
        const result = this.sealResult(record, this.active)
        await this.agent.request('POST', `/v1/pairings/${encodeURIComponent(pairingId)}/result`, {
          state: 'bound',
          envelope: result.envelope,
        })
        this.lastResult = { state: 'bound', binding_id: record.binding_id, at: Date.now() }
        this.store.audit('pairing-bound', { pairingId, bindingId: record.binding_id })
        this.log.info(`[dsh-puppet] controller paired: ${record.controller_id}`)
        this.active = null
        processed += 1
      } catch (error) {
        const reason = error?.code ?? error?.message ?? 'invalid_invitation'
        this.log.warn(`[dsh-puppet] pairing rejected: ${reason}`)
        this.store.audit('pairing-rejected', { pairingId, reason })
        try {
          await this.agent.request('POST', `/v1/pairings/${encodeURIComponent(pairingId)}/result`, {
            state: 'rejected',
            reason: String(reason).slice(0, 120),
          })
        } catch {
          // The controller will see the pairing expire if the relay is gone.
        }
        this.lastResult = { state: 'rejected', reason, at: Date.now() }
        this.active = null
        processed += 1
      }
    }
    return processed
  }

  openInvitation(envelope, active) {
    if (!envelope || typeof envelope !== 'object' || !envelope.enc || !envelope.ct) {
      throw pairingError('invalid_envelope')
    }
    const info = Buffer.from(`puppetry1/pair-request/${active.pairingId}`, 'utf8')
    const aad = sha256(Buffer.from(stableStringify({ v: 1, type: 'bind.request', pid: active.pairingId }), 'utf8'))
    const keys = identityKeys(this.identity)
    const plaintext = openBase({
      recipientPriv: keys.x.priv,
      enc: unb64u(envelope.enc),
      info,
      aad,
      ciphertext: unb64u(envelope.ct),
    })
    return JSON.parse(plaintext.toString('utf8'))
  }

  async bind(invitation, active) {
    if (invitation?.v !== 1 || invitation.type !== 'bind.request') throw pairingError('bad_invitation')
    if (invitation.pairing_id !== active.pairingId) throw pairingError('pairing_mismatch')
    if (invitation.agent_id !== this.agent.agentId) throw pairingError('agent_mismatch')
    if (Number(invitation.exp) < Date.now()) throw pairingError('invitation_expired')
    if (Math.abs(Date.now() - Number(invitation.ts)) > 5 * 60 * 1000) throw pairingError('stale_invitation')

    const controllerEd = unb64u(invitation.controller_ed)
    const controllerX = unb64u(invitation.controller_x)
    if (controllerEd.length !== 32 || controllerX.length !== 32) throw pairingError('bad_controller_key')
    if (controllerIdFromPublic(controllerEd) !== invitation.controller_id) {
      throw pairingError('controller_id_mismatch')
    }

    const proofInput = Buffer.from(
      `puppetry1-pair\n${active.pairingId}\n${invitation.controller_ed}\n${invitation.controller_x}\n${invitation.ts}\n${invitation.nonce}`,
      'utf8',
    )
    const expectedProof = createHmac('sha256', unb64u(active.psk)).update(proofInput).digest()
    const suppliedProof = unb64u(invitation.proof)
    if (
      suppliedProof.length !== expectedProof.length ||
      !timingSafeEqual(suppliedProof, expectedProof)
    ) {
      throw pairingError('bad_proof')
    }

    const scopes = Array.isArray(invitation.scopes) ? invitation.scopes : []
    const allowed = this.allowedScopes()
    const denied = scopes.filter((scope) => !allowed.has(String(scope)))
    if (denied.length > 0) throw pairingError(`scope_denied:${denied.join(',')}`)
    if (scopes.length === 0) throw pairingError('no_scopes')

    const record = {
      v: 1,
      binding_id: String(invitation.binding_id ?? `bd_${randomToken(12)}`),
      agent_id: this.identity.agentId,
      agent_ed: this.identity.ed.pub,
      agent_x: this.identity.x.pub,
      controller_id: invitation.controller_id,
      controller_ed: invitation.controller_ed,
      controller_x: invitation.controller_x,
      scopes: [...new Set(scopes.map(String))],
      created_at: Number(invitation.created_at ?? Date.now()),
      expires_at: null,
    }

    const payload = Buffer.from(stableStringify(bindingPayload(record)), 'utf8')
    if (!invitation.controller_sig || !verifyBytes(payload, unb64u(invitation.controller_sig), controllerEd)) {
      throw pairingError('bad_controller_signature')
    }
    record.controller_sig = invitation.controller_sig
    record.agent_sig = signBindingPayload(record, this.identity)

    // Agent-level mk is shared across bindings so every controller can decrypt
    // the same sealed digest (e2e-encryption.md §1.4); keep a copy on the record for convenience.
    const metaKey = this.store.ensureMetaKey()
    record.meta_key = metaKey
    record.meta_epoch = this.store.metaEpoch()
    this.store.addBinding(record)
    return record
  }

  sealResult(record, active) {
    const metaKey = record.meta_key
    const result = {
      v: 1,
      type: 'bind.result',
      pairing_id: active.pairingId,
      binding_id: record.binding_id,
      agent_id: record.agent_id,
      agent_ed: record.agent_ed,
      agent_x: record.agent_x,
      controller_id: record.controller_id,
      scopes: record.scopes,
      created_at: record.created_at,
      agent_sig: record.agent_sig,
      meta_key: metaKey,
      meta_epoch: 1,
      ts: Date.now(),
    }
    const resultSig = signBytes(Buffer.from(stableStringify(result), 'utf8'), this.identity)
    const header = {
      v: 1,
      type: 'bind.result',
      pairing_id: active.pairingId,
      exp: Date.now() + 60 * 60 * 1000,
    }
    const info = Buffer.from(`puppetry1/pair-result/${active.pairingId}`, 'utf8')
    const aad = sha256(Buffer.from(stableStringify({ v: 1, type: 'bind.result', pid: active.pairingId }), 'utf8'))
    const keys = identityKeys(this.identity)
    const sealed = sealAuth({
      recipientPub: unb64u(record.controller_x),
      senderPriv: keys.x.priv,
      info,
      aad,
      plaintext: Buffer.from(stableStringify({ ...result, result_sig: b64u(resultSig) }), 'utf8'),
    })
    return {
      envelope: { enc: b64u(sealed.enc), ct: b64u(sealed.ct) },
      header,
    }
  }
}

function pairingError(code) {
  const error = new Error(code)
  error.code = code
  return error
}
