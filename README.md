# snrdlr

An experimental chat app where the only way to add someone is to meet them: one person shows a QR code, the other scans it, and they chat peer to peer over WebRTC. No account and no install.

**Status: Phases 1, 2 and 4 of the plan.** People pair through a QR code that only works while it is being shown, exchange signed and encrypted text in groups and direct chats, and keep their chats and history on the device. Only people who were invited are let into a chat. Messages written while someone is away reach them the next time they are online together with any member who has them. Nobody has reviewed the cryptography. Do not rely on it for anything private.

## How it works

- **Identity.** Each device makes an Ed25519 signing key and an X25519 key on first launch. There is no account and no recovery.
- **Groups.** A group has a random 32-byte secret and a founder. Everyone derives a room ID, a signaling password and a message key from the secret and the founder's key with HKDF-SHA256.
- **Invites.** A code carries only a random one-time token and the inviter's public key, in a URL fragment (`#i=…`) that browsers never send to the server. While the inviter keeps the code on screen, their app waits in a temporary room derived from the token. A joiner sends a signed request naming their keys and gets back, signed, the group's secret and a certificate admitting them. Closing the code forgets the token, so a saved or forwarded code stops working.
- **Membership.** Certificates chain from the founder down: each is signed by a member admitting the next. On every connection each side proves it holds a member's key, with a signature tied to that connection's encryption fingerprints so it cannot be relayed. Anyone who reaches the room without proving membership is ignored, even if they hold the group's secret. Each member's "joined" message carries their certificates, and a message is only kept, shown or passed on if its author is known to be a member, so it does not matter who delivered it.
- **Direct chats.** A "chat with me" code works the same way, but no secret travels: the two people derive the chat's keys from an X25519 agreement between their identities. Nobody can be added; "Add someone" starts a new group instead.
- **Transport.** [Trystero](https://github.com/dmotz/trystero) finds peers through public Nostr relays, which see only a hash of the room ID and password-encrypted connection setup. Messages travel over WebRTC data channels, directly where possible and through a TURN relay otherwise.
- **Messages.** Every message is signed by its author, then encrypted with the chat's message key (AES-256-GCM), so other members cannot forge or alter it or copy it into another chat.
- **Sync.** When members connect, they compare how much of each author's log they hold and send each other what is missing, so history spreads through whoever is online. Chats that are not open catch up when the app is opened. When the app returns from the background it checks its connections and rejoins if they have died.
- **Storage.** Identity, chats and messages are kept in IndexedDB on the device.

## Develop

```sh
npm install
npm run dev      # local dev server
npm test         # unit tests (keys, invites, membership, envelopes, storage, sync, TURN worker)
npm run e2e      # two-browser pairing test, against a relay started on this machine
npm run build    # typecheck and build to dist/
```

For manual testing in desktop browsers without touching public relays, run `npm run relay` in one terminal and `npm run dev:local` in another. The local relay (`scripts/local-relay.mjs`) is in-memory and unauthenticated, and only listens on localhost.

To try it on phones, serve it over HTTPS (for example the GitHub Pages deploy in `.github/workflows/deploy.yml`), start a chat on one phone and scan the code with the other.

## License

MIT
