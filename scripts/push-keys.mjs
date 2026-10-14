// Makes the relay's push key pair. The private half goes straight into the relay as a Cloudflare
// secret (VAPID_PRIVATE_KEY) and is never shown or saved; the public half is written to src/push-key.ts,
// to be committed. Run it once, from the repository's root:
//
//   CLOUDFLARE_ACCOUNT_ID=... node scripts/push-keys.mjs
//
// Running it again makes a new pair, after which every device has to turn notifications on again;
// it refuses unless given --replace.
import {spawnSync} from 'node:child_process'
import {readFileSync, writeFileSync} from 'node:fs'

const KEY_FILE = new URL('../src/push-key.ts', import.meta.url)
const current = readFileSync(KEY_FILE, 'utf8')
if (!/PUSH_PUBLIC_KEY = ''/.test(current) && !process.argv.includes('--replace')) {
  console.error('There is a push key already. A new one means every device turns notifications on again; add --replace to go ahead.')
  process.exit(1)
}

const pair = await crypto.subtle.generateKey({name: 'ECDSA', namedCurve: 'P-256'}, true, ['sign', 'verify'])
const privateJwk = await crypto.subtle.exportKey('jwk', pair.privateKey)
const publicKey = Buffer.from(await crypto.subtle.exportKey('raw', pair.publicKey)).toString('base64url')

const put = spawnSync('npx', ['wrangler', 'secret', 'put', 'VAPID_PRIVATE_KEY', '-c', 'worker-relay/wrangler.toml'], {
  input: JSON.stringify({kty: privateJwk.kty, crv: privateJwk.crv, x: privateJwk.x, y: privateJwk.y, d: privateJwk.d}),
  stdio: ['pipe', 'inherit', 'inherit']
})
if (put.status !== 0) {
  console.error('Could not set the secret, so nothing was changed.')
  process.exit(1)
}
writeFileSync(KEY_FILE, current.replace(/PUSH_PUBLIC_KEY = '[^']*'/, `PUSH_PUBLIC_KEY = '${publicKey}'`))
console.log(`\nDone. The relay has its private key, and src/push-key.ts has the public one:\n${publicKey}`)
