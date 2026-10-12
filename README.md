# snrdlr

An experimental chat app where the only way to add someone is to meet them: one person shows a QR code, the other scans it, and they chat peer to peer over WebRTC. No account and no install.

**Status: Phase 2, live invites, and the first half of Phase 4 (sync and reconnect).** People pair through a QR code that only works while it is being shown, exchange signed and encrypted text, and keep their chats and history on the device. Messages written while someone is away reach them the next time they are online together with any member who has them. Nobody has reviewed the cryptography. Do not rely on it for anything private.

## How it works

- Starting a chat makes a random 32-byte secret, which never appears in a QR code.
- An invite code carries only a random one-time token and the inviter's public key, in a URL fragment (`#i=…`) that browsers never send to the server. While the inviter keeps the code on screen, their app waits in a temporary room derived from the token and sends the chat's secret, signed, to anyone who arrives. Closing the code forgets the token, so a saved or forwarded code stops working.
- Everyone derives a room ID, a signaling password and a message key from the secret with HKDF-SHA256.
- [Trystero](https://github.com/dmotz/trystero) finds the other peers through public Nostr relays, which see only a hash of the room ID and password-encrypted connection setup. Messages then travel over WebRTC data channels, directly where possible and through a TURN relay otherwise.
- Each device makes an Ed25519 identity on first launch. Every message is signed by its author, then encrypted with the chat's message key (AES-256-GCM), so other members cannot forge or alter it.
- When members connect, they compare how much of each author's log they hold and send each other what is missing, so history spreads through whoever is online. When the app returns from the background it checks its connections and rejoins if they have died.
- Identity, chats and messages are stored in IndexedDB on the device. There is no account and no recovery.

## Develop

```sh
npm install
npm run dev      # local dev server
npm test         # unit tests (keys, invites, envelopes, storage, sessions, TURN worker)
npm run e2e      # two-browser pairing test, against a relay started on this machine
npm run build    # typecheck and build to dist/
```

For manual testing in desktop browsers without touching public relays, run `npm run relay` in one terminal and `npm run dev:local` in another. The local relay (`scripts/local-relay.mjs`) is in-memory and unauthenticated, and only listens on localhost.

To try it on phones, serve it over HTTPS (for example the GitHub Pages deploy in `.github/workflows/deploy.yml`), start a chat on one phone and scan the code with the other.

## License

MIT
