import {
  createHmac,
  createPrivateKey,
  createPublicKey,
  diffieHellman,
  generateKeyPairSync,
  randomBytes,
} from 'node:crypto'
import { open as aeadOpen, seal as aeadSeal } from './chacha20poly1305.js'

/**
 * Minimal HPKE (RFC 9180) for the one suite Puppetry fixes:
 *   DHKEM(X25519, HKDF-SHA256), HKDF-SHA256, ChaCha20-Poly1305
 *
 * Only base and auth modes are implemented; no PSK, no exporter API. That is
 * enough for the agent half: open controller commands (auth), seal results
 * (auth), and seal one-shot metadata to a controller (base/auth).
 */

const KEM_ID = 0x0020
const KDF_ID = 0x0001
const AEAD_ID = 0x0003
const MODE_BASE = 0x00
const MODE_AUTH = 0x02
const Nk = 32
const Nn = 12
const Nh = 32

const SUITE_ID = Buffer.concat([
  Buffer.from('HPKE', 'ascii'),
  u16(KEM_ID),
  u16(KDF_ID),
  u16(AEAD_ID),
])
const HPKE_V1 = Buffer.from('HPKE-v1', 'ascii')

function u16(n) {
  const b = Buffer.alloc(2)
  b.writeUInt16BE(n, 0)
  return b
}

function i2osp(n, len) {
  const b = Buffer.alloc(len)
  if (len === 2) b.writeUInt16BE(n, 0)
  else if (len === 1) b.writeUInt8(n, 0)
  else throw new Error('unsupported I2OSP length')
  return b
}

function labeledExtract(salt, label, ikm) {
  const labeled = Buffer.concat([HPKE_V1, SUITE_ID, Buffer.from(label, 'ascii'), ikm])
  return createHmac('sha256', salt ?? Buffer.alloc(0)).update(labeled).digest()
}

function hkdfExpand(prk, info, length) {
  const chunks = []
  let t = Buffer.alloc(0)
  let counter = 1
  let produced = 0
  while (produced < length) {
    t = createHmac('sha256', prk)
      .update(Buffer.concat([t, info, Buffer.from([counter])]))
      .digest()
    chunks.push(t)
    produced += t.length
    counter += 1
  }
  return Buffer.concat(chunks).subarray(0, length)
}

function labeledExpand(prk, label, info, length) {
  const labeled = Buffer.concat([
    i2osp(length, 2),
    HPKE_V1,
    SUITE_ID,
    Buffer.from(label, 'ascii'),
    info,
  ])
  return hkdfExpand(prk, labeled, length)
}

function extractAndExpand(dh, kemContext) {
  const eaePrk = labeledExtract(Buffer.alloc(0), 'eae_prk', dh)
  return labeledExpand(eaePrk, 'shared_secret', kemContext, Nh)
}

function keySchedule(mode, sharedSecret, info) {
  const pskIdHash = labeledExtract(Buffer.alloc(0), 'psk_id_hash', Buffer.alloc(0))
  const infoHash = labeledExtract(Buffer.alloc(0), 'info_hash', info)
  const context = Buffer.concat([Buffer.from([mode]), pskIdHash, infoHash])
  const secret = labeledExtract(sharedSecret, 'secret', Buffer.alloc(0))
  return {
    key: labeledExpand(secret, 'key', context, Nk),
    baseNonce: labeledExpand(secret, 'base_nonce', context, Nn),
    exporterSecret: labeledExpand(secret, 'exp', context, Nh),
  }
}

function nonceFor(baseNonce, seq) {
  const nonce = Buffer.from(baseNonce)
  const seqBytes = Buffer.alloc(8)
  seqBytes.writeBigUInt64BE(BigInt(seq), 0)
  for (let i = 0; i < 8; i += 1) nonce[Nn - 8 + i] ^= seqBytes[i]
  return nonce
}

function x25519Public(raw) {
  return createPublicKey({
    key: { kty: 'OKP', crv: 'X25519', x: raw.toString('base64url') },
    format: 'jwk',
  })
}

function x25519Private(raw) {
  return createPrivateKey({
    key: {
      kty: 'OKP',
      crv: 'X25519',
      d: raw.toString('base64url'),
      x: x25519PublicFromPrivate(raw).toString('base64url'),
    },
    format: 'jwk',
  })
}

/**
 * Derive the public half from a raw X25519 private key. Node exposes it from
 * the JWK export, but importing a private JWK needs the public member too.
 */
function x25519PublicFromPrivate(raw) {
  const pub = Buffer.alloc(32)
  // Node's crypto can derive it through createPrivateKey + export; doing that
  // here keeps the raw-key API small. The temporary JWK omits `x`, which
  // createPrivateKey rejects, so use a one-off generated pair's export path.
  const tmp = createPrivateKey({
    key: Buffer.concat([Buffer.from('302e020100300506032b656e04220420', 'hex'), raw]),
    format: 'der',
    type: 'pkcs8',
  })
  const jwk = tmp.export({ format: 'jwk' })
  Buffer.from(jwk.x, 'base64url').copy(pub)
  return pub
}

function dh(privateRaw, publicRaw) {
  return diffieHellman({
    privateKey: x25519Private(privateRaw),
    publicKey: x25519Public(publicRaw),
  })
}

export function generateX25519() {
  const { publicKey, privateKey } = generateKeyPairSync('x25519')
  const pub = publicKey.export({ format: 'jwk' })
  const priv = privateKey.export({ format: 'jwk' })
  return {
    publicKey: Buffer.from(pub.x, 'base64url'),
    privateKey: Buffer.from(priv.d, 'base64url'),
  }
}

/**
 * HPKE base mode: sender is anonymous; used for the pairing request where the
 * controller's identity is carried by a signature inside the plaintext.
 */
export function sealBase({ recipientPub, info, aad, plaintext }) {
  const eph = generateX25519()
  const dh1 = dh(eph.privateKey, recipientPub)
  const kemContext = Buffer.concat([eph.publicKey, recipientPub])
  const sharedSecret = extractAndExpand(dh1, kemContext)
  const keys = keySchedule(MODE_BASE, sharedSecret, info)
  return {
    enc: eph.publicKey,
    ct: aeadSeal(keys.key, nonceFor(keys.baseNonce, 0), aad, plaintext),
  }
}

export function openBase({ recipientPriv, enc, info, aad, ciphertext }) {
  const dh1 = dh(recipientPriv, enc)
  const kemContext = Buffer.concat([enc, x25519PublicFromPrivate(recipientPriv)])
  const sharedSecret = extractAndExpand(dh1, kemContext)
  const keys = keySchedule(MODE_BASE, sharedSecret, info)
  return aeadOpen(keys.key, nonceFor(keys.baseNonce, 0), aad, ciphertext)
}

/**
 * HPKE auth mode: the recipient learns the sender's static X25519 identity.
 * This is the normal command/result envelope.
 */
export function sealAuth({ recipientPub, senderPriv, info, aad, plaintext }) {
  const eph = generateX25519()
  const dh1 = dh(eph.privateKey, recipientPub)
  const dh2 = dh(senderPriv, recipientPub)
  const kemContext = Buffer.concat([
    eph.publicKey,
    recipientPub,
    x25519PublicFromPrivate(senderPriv),
  ])
  const sharedSecret = extractAndExpand(Buffer.concat([dh1, dh2]), kemContext)
  const keys = keySchedule(MODE_AUTH, sharedSecret, info)
  return {
    enc: eph.publicKey,
    ct: aeadSeal(keys.key, nonceFor(keys.baseNonce, 0), aad, plaintext),
  }
}

export function openAuth({ recipientPriv, senderPub, enc, info, aad, ciphertext }) {
  const dh1 = dh(recipientPriv, enc)
  const dh2 = dh(recipientPriv, senderPub)
  const kemContext = Buffer.concat([
    enc,
    x25519PublicFromPrivate(recipientPriv),
    senderPub,
  ])
  const sharedSecret = extractAndExpand(Buffer.concat([dh1, dh2]), kemContext)
  const keys = keySchedule(MODE_AUTH, sharedSecret, info)
  return aeadOpen(keys.key, nonceFor(keys.baseNonce, 0), aad, ciphertext)
}

/** Symmetric AEAD used for the sealed session digest (mk). */
export function sealSymmetric(key, plaintext, aad, nonce = randomBytes(12)) {
  return {
    nonce,
    ct: aeadSeal(key, nonce, aad, plaintext),
  }
}

export function openSymmetric(key, nonce, ciphertext, aad) {
  return aeadOpen(key, nonce, aad, ciphertext)
}
