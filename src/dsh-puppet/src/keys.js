import {
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  sign,
  verify,
} from 'node:crypto'
import { base32Lower, b64u, sha256, unb64u } from './util.js'

export function generateIdentity() {
  const ed = generateKeyPairSync('ed25519')
  const x = generateKeyPairSync('x25519')
  const edPub = Buffer.from(ed.publicKey.export({ format: 'jwk' }).x, 'base64url')
  const edPriv = Buffer.from(ed.privateKey.export({ format: 'jwk' }).d, 'base64url')
  const xPub = Buffer.from(x.publicKey.export({ format: 'jwk' }).x, 'base64url')
  const xPriv = Buffer.from(x.privateKey.export({ format: 'jwk' }).d, 'base64url')
  return {
    createdAt: new Date().toISOString(),
    agentId: agentIdFromPublic(edPub),
    ed: { pub: b64u(edPub), priv: b64u(edPriv) },
    x: { pub: b64u(xPub), priv: b64u(xPriv) },
  }
}

export function agentIdFromPublic(edPub) {
  return `ag_${base32Lower(sha256(edPub).subarray(0, 15))}`
}

export function controllerIdFromPublic(edPub) {
  return `ct_${base32Lower(sha256(edPub).subarray(0, 15))}`
}

export function keyId(pub) {
  return base32Lower(sha256(pub).subarray(0, 8))
}

export function edPrivateKey(raw) {
  return createPrivateKey({
    key: { kty: 'OKP', crv: 'Ed25519', d: b64u(raw), x: b64u(edPublicFromPrivate(raw)) },
    format: 'jwk',
  })
}

export function edPublicKey(raw) {
  return createPublicKey({
    key: { kty: 'OKP', crv: 'Ed25519', x: b64u(raw) },
    format: 'jwk',
  })
}

function edPublicFromPrivate(raw) {
  // Ed25519 PKCS8 prefix 302e020100300506032b657004220420 || seed
  const der = Buffer.concat([
    Buffer.from('302e020100300506032b657004220420', 'hex'),
    raw,
  ])
  const key = createPrivateKey({ key: der, format: 'der', type: 'pkcs8' })
  return Buffer.from(key.export({ format: 'jwk' }).x, 'base64url')
}

export function identityKeys(identity) {
  return {
    ed: {
      pub: unb64u(identity.ed.pub),
      priv: unb64u(identity.ed.priv),
    },
    x: {
      pub: unb64u(identity.x.pub),
      priv: unb64u(identity.x.priv),
    },
  }
}

export function signBytes(buffer, identity) {
  const keys = identityKeys(identity)
  return sign(null, buffer, edPrivateKey(keys.ed.priv))
}

export function verifyBytes(buffer, signature, edPubRaw) {
  try {
    return verify(null, buffer, edPublicKey(edPubRaw), signature)
  } catch {
    return false
  }
}
