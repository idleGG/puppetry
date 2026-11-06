import test from 'node:test'
import assert from 'node:assert/strict'
import { seal, open } from '../src/crypto/chacha20poly1305.js'
import { generateX25519, openAuth, openBase, sealAuth, sealBase } from '../src/crypto/hpke.js'

const key = Buffer.from('808182838485868788898a8b8c8d8e8f909192939495969798999a9b9c9d9e9f', 'hex')
const nonce = Buffer.from('070000004041424344454647', 'hex')
const aad = Buffer.from('50515253c0c1c2c3c4c5c6c7', 'hex')
const plaintext = Buffer.from(
  "Ladies and Gentlemen of the class of '99: If I could offer you only one tip for the future, sunscreen would be it.",
)
const expected = Buffer.from(
  [
    'd31a8d34648e60db7b86afbc53ef7ec2',
    'a4aded51296e08fea9e2b5a736ee62d6',
    '3dbea45e8ca9671282fafb69da92728b',
    '1a71de0a9e060b2905d6a5b67ecd3b36',
    '92ddbd7f2d778b8c9803aee328091b58',
    'fab324e4fad675945585808b4831d7bc',
    '3ff4def08e4b7a9de576d26586cec64b',
    '6116',
  ].join('') + '1ae10b594f09e26a7e902ecbd0600691',
  'hex',
)

test('ChaCha20-Poly1305 matches RFC 8439 section 2.8.2', () => {
  const sealed = seal(key, nonce, aad, plaintext)
  assert.equal(sealed.length, plaintext.length + 16)
  assert.deepEqual(sealed, expected)
  assert.deepEqual(open(key, nonce, aad, sealed), plaintext)
})

test('AEAD rejects a modified tag', () => {
  const sealed = seal(key, nonce, aad, plaintext)
  sealed[sealed.length - 1] ^= 1
  assert.throws(() => open(key, nonce, aad, sealed), /authentication/u)
})

test('HPKE auth mode round-trips and binds the sender', () => {
  const sender = generateX25519()
  const recipient = generateX25519()
  const info = Buffer.from('puppetry1/cmd/bd_test')
  const header = Buffer.from('{"v":1}')
  const message = Buffer.from('hello')
  const sealed = sealAuth({
    recipientPub: recipient.publicKey,
    senderPriv: sender.privateKey,
    info,
    aad: header,
    plaintext: message,
  })
  const opened = openAuth({
    recipientPriv: recipient.privateKey,
    senderPub: sender.publicKey,
    enc: sealed.enc,
    info,
    aad: header,
    ciphertext: sealed.ct,
  })
  assert.deepEqual(opened, message)

  const wrongSender = generateX25519()
  assert.throws(() =>
    openAuth({
      recipientPriv: recipient.privateKey,
      senderPub: wrongSender.publicKey,
      enc: sealed.enc,
      info,
      aad: header,
      ciphertext: sealed.ct,
    }),
  )
})

test('HPKE base mode round-trips', () => {
  const recipient = generateX25519()
  const info = Buffer.from('puppetry1/pair')
  const aad = Buffer.from('x')
  const message = Buffer.from('pair request')
  const sealed = sealBase({ recipientPub: recipient.publicKey, info, aad, plaintext: message })
  assert.deepEqual(
    openBase({ recipientPriv: recipient.privateKey, enc: sealed.enc, info, aad, ciphertext: sealed.ct }),
    message,
  )
})
