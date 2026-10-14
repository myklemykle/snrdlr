import {describe, expect, it} from 'vitest'
import {encryptPush, fromBase64Url, publicKeyOf, sendPush, toBase64Url, vapidHeader} from './webpush'

// The worked example in RFC 8291, appendix A.
const RFC = {
  plaintext: 'When I grow up, I want to be a watermelon',
  senderPrivate: 'yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw',
  senderPublic: 'BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8',
  receiverPublic: 'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4',
  auth: 'BTBZMqHH6r4Tts7J_aSIgg',
  salt: 'DGv6ra1nlYgDCS1FRnbzlw',
  result:
    'DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN'
}

const jwkFrom = (privateKey: string, publicKey: string): JsonWebKey => {
  const raw = fromBase64Url(publicKey)
  return {kty: 'EC', crv: 'P-256', d: privateKey, x: toBase64Url(raw.slice(1, 33)), y: toBase64Url(raw.slice(33))}
}

describe('web push', () => {
  it('encrypts exactly as the RFC example does', async () => {
    const sender = jwkFrom(RFC.senderPrivate, RFC.senderPublic)
    expect(toBase64Url(publicKeyOf(sender))).toBe(RFC.senderPublic)
    const out = await encryptPush(new TextEncoder().encode(RFC.plaintext), {p256dh: RFC.receiverPublic, auth: RFC.auth}, {sender, salt: fromBase64Url(RFC.salt)})
    expect(toBase64Url(out)).toBe(RFC.result)
  })

  it('signs a VAPID token for the push service, which the public key it names checks', async () => {
    const pair = (await crypto.subtle.generateKey({name: 'ECDSA', namedCurve: 'P-256'}, true, ['sign', 'verify'])) as CryptoKeyPair
    const vapid = await crypto.subtle.exportKey('jwk', pair.privateKey)
    const header = await vapidHeader('https://web.push.apple.com/abc', vapid, 'https://alpha.snrdlr.net', 1_000_000_000_000)
    const [, token, key] = header.match(/^vapid t=([^,]+), k=(.+)$/)!
    const [head, claims, signature] = token.split('.')
    expect(JSON.parse(new TextDecoder().decode(fromBase64Url(claims)))).toEqual({aud: 'https://web.push.apple.com', exp: 1_000_043_200, sub: 'https://alpha.snrdlr.net'})
    const publicKey = await crypto.subtle.importKey('raw', fromBase64Url(key), {name: 'ECDSA', namedCurve: 'P-256'}, false, ['verify'])
    const valid = await crypto.subtle.verify({name: 'ECDSA', hash: 'SHA-256'}, publicKey, fromBase64Url(signature), new TextEncoder().encode(`${head}.${claims}`))
    expect(valid).toBe(true)
  })

  it('says when a device is gone for good', async () => {
    const pair = (await crypto.subtle.generateKey({name: 'ECDSA', namedCurve: 'P-256'}, true, ['sign'])) as CryptoKeyPair
    const vapid = await crypto.subtle.exportKey('jwk', pair.privateKey)
    const target = {endpoint: 'https://push.example/x', p256dh: RFC.receiverPublic, auth: RFC.auth}
    const sent: RequestInit[] = []
    const answer = (status: number) => (async (_url: string, init: RequestInit) => (sent.push(init), new Response(null, {status}))) as unknown as typeof fetch
    expect(await sendPush(target, {t: 'x'}, {vapid, subject: 'https://a', collapse: 'abc', fetcher: answer(201)})).toBe('sent')
    expect(await sendPush(target, {t: 'x'}, {vapid, subject: 'https://a', fetcher: answer(410)})).toBe('gone')
    expect(await sendPush(target, {t: 'x'}, {vapid, subject: 'https://a', fetcher: answer(500)})).toBe('failed')
    expect(sent[0].headers).toMatchObject({'Content-Encoding': 'aes128gcm', Topic: 'abc', Urgency: 'high'})
  })
})
