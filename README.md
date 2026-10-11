# snrdlr

An experimental chat app where the only way to add someone is to meet them: one person shows a QR code, the other scans it, and they chat peer to peer over WebRTC. No account and no install.

**Status: Phase 1a.** Two or more browsers can pair through a QR code and exchange text. Nothing is stored yet, messages are not signed, and there is no TURN fallback, so some network pairs will fail to connect. Do not rely on it for anything private.

## How it works

- Starting a chat makes a random 32-byte secret and puts it in the URL fragment (`#i=…`), which browsers never send to the server. The QR code encodes that URL.
- Both sides derive a room ID and a signaling password from the secret with HKDF-SHA256.
- [Trystero](https://github.com/dmotz/trystero) finds the other peer through public Nostr relays, which see only a hash of the room ID and password-encrypted connection setup. Messages then travel over the WebRTC data channel.

## Develop

```sh
npm install
npm run dev      # local dev server
npm test         # unit tests (key derivation, invite encoding)
npm run e2e      # two-browser pairing test; needs network access to public relays
npm run build    # typecheck and build to dist/
```

To try it on phones, serve it over HTTPS (for example the GitHub Pages deploy in `.github/workflows/deploy.yml`), start a chat on one phone and scan the code with the other.

## License

MIT
