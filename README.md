# snrdlr

An experimental chat app where the only way to add someone is to meet them: one person shows a QR code, the other scans it, and they chat peer to peer over WebRTC. No account and no install.

**Try it: https://alpha.snrdlr.net/** This is a test deployment; chats may be wiped by any update.

**Status (15 October 2026): a working test, used by its developer and a few testers.** Nobody has reviewed the cryptography. Do not rely on it for anything private. What is planned next, and what was decided along the way, is in [BACKLOG.md](BACKLOG.md).

The app is invite-only: a device gets in by joining a chat through someone's invite, or by being added to a person's other device. That is a courtesy gate in the app itself (`src/gate.ts`), not a lock.

## What it does

- **Meet to connect.** "Chat with one person" or "Start a group" shows a QR code (and a link to copy) that only works while it is on screen. Scanning it, with the app or the phone's camera, joins the chat. Several people can join through one code while it shows.
- **Chats.** Text (several lines; web addresses can be tapped (snrdlr links, such as invites, open in the same tab; others in a new one), and the first that points at a picture shows it below the message, unless turned off in Settings, since the picture comes from the site that has it; what you type and leave unsent waits in each chat's box until you come back), voice messages (up to five minutes; the Send button records while the box is empty; listened to before sending; played at 1×, 1.5× or 2×), pictures (several at once, with a caption), replies, editing your own messages (up arrow in an empty box edits the last one), one emoji reaction per person per message (quick set plus a full picker, searched by name or everyday words such as "haha" or "100"), renaming a group, leaving a chat. "Add someone" in a direct chat starts a new group, after asking what to call it (nothing is made if cancelled).
- **Profiles.** A name, plus optional icon, photo, contact and colour, each shown only in the chats you choose (`src/profile.ts`, `src/cards.ts`). Where you show your colour, your own messages are in it too, darkened as far as white words need. In a chat, your own profile lets you hide there what you show everywhere, or show something else there instead (another icon, colour or contact).
- **One person, several devices.** Settings → Your devices → Add a device: one device shows a code, the other scans or opens it, both show the same six-digit number, and the new device becomes you, with your chats. Your devices keep each other's chat lists, read positions and your profile in step through a hidden chat of your own; the others show a notice when a device they did not add appears (`src/devices.ts`, `src/link-device.ts`).
- **Offline delivery.** Every message is also left, sealed, with our relay for 30 days, so members who were away get it when they next open the app, even if nobody else is online. Each is locked to the members its writer knew of, so whenever a device learns of someone new in a group, it leaves everyone's latest profile again for all: a profile carries its writer's proof of membership, and without it a member's messages cannot be kept. A device only counts the relay as caught up on once it could keep everything there. Back after more than half a minute out of sight, the app reconnects to the relay at once instead of first testing the old connection, which a phone has usually let die without saying so (`src/mailbox.ts`).
- **Notifications.** Settings → Notifications. The relay wakes the other members' devices through the browser's push service when a message is left for them. A notification names the chat, never the message. None are sent to any of your devices while you are actively using snrdlr on one of them. On an iPhone only the Home Screen app can receive them; tapping one can open the chat in Safari (`src/push.ts`, `src/push-view.tsx`, `public/sw.js`).
- **The chat list** shows direct chats first, each with the other person's icon and colour, then groups, each with the latest message first; with unread counts, shared across your devices.
- **Sounds.** A sound when a message is sent, or when a fresh one arrives while the app is open; sets are the folders in `src/sounds` (snrdl, plink, groovy) plus "shhhhh" for none, each with its own volume.
- **Install.** It can be installed to the home screen and opens without a network once it has been opened before. Open tabs update themselves to a new version once nobody is using them; Settings shows the running version.
- **One tab at a time.** Each browser keeps one snrdlr tab connected: the newest takes over, and any other steps aside, holding nothing, with a button to take over again (`src/one-tab.ts`).
- **Stay connected** (desktop): keeps every chat connected while the tab is open, so it hands messages on to members who come online later.

## How it works

- **Identity.** Each person has an Ed25519 signing key and an X25519 key, made on their first device and copied to the others when a device is added; each device also has a tag of its own and numbers its own messages. There is no account and no recovery.
- **Groups.** A group has a random 32-byte secret and a founder. Everyone derives a room ID, a signaling password and a message key from the secret and the founder's key with HKDF-SHA256.
- **Invites.** A code carries only a random one-time token and the inviter's public key, in a URL fragment (`#i=…`) that browsers never send to the server. While the inviter keeps the code on screen, their app waits in a temporary room derived from the token. A joiner sends a signed request naming their keys and gets back, signed, the group's secret and a certificate admitting them. Closing the code forgets the token, so a saved or forwarded code stops working.
- **Invites from afar** (a testing aid, not yet offered to everyone). An Invites sheet makes a link that works for a chosen time, from a minute to a week, with nobody needing to be online when it is opened, and can be cancelled sooner. The link (`#r=…`) holds only a random seed, from which both sides work out a topic on the relay and a key. What a joiner needs is left there sealed with that key: for a group, the group's secret and the key of a throwaway member the inviter admitted, which the joiner uses to admit themselves; for a direct chat, the inviter's public keys. The relay keeps it only until the invite ends, and deletes it at once when shown a cancel key that never leaves the inviter's devices. A group link lets in everyone who opens it; a direct-chat link makes one chat: the joiner leaves an answer that only the inviter can open, and the inviter's device makes the same chat when it sees it. Cancelling stops new people but removes nobody: whoever opened a group link holds its secret. The person's open invites are shared among their devices through their hidden chat (`src/remote-invite.ts`, `src/invites-view.tsx`, `src/standing-invite.ts`).
- **Checking a chat** (a testing aid). Each chat has a "Check what's held" button that reports, for each person and device, how many of their messages this device holds, the highest number and any gaps, then the same for what the relay holds for the chat that this device can open, and how many of those are missing here. It gives counts and dates only, never what was said, so the report can be copied and passed on (`src/diagnose.ts`). A live code that fails to let someone in says whether the inviter was reached at all; in developer mode it also says how many signalling relays were connected, how many TURN servers were had, and how many others were met in the invite's room.
- **Membership.** Certificates chain from the founder down: each is signed by a member admitting the next. On every connection each side proves it holds a member's key, with a signature tied to that connection's encryption fingerprints so it cannot be relayed. Anyone who reaches the room without proving membership is ignored, even if they hold the group's secret. Each member's "joined" message carries their certificates, and a message is only kept, shown or passed on if its author is known to be a member, so it does not matter who delivered it.
- **Direct chats.** A "chat with me" code works the same way, but no secret travels: the two people derive the chat's keys from an X25519 agreement between their identities. Nobody can be added; "Add someone" starts a new group instead.
- **Messages.** Every message is signed by its author, then encrypted with the chat's message key (AES-256-GCM), so other members cannot forge or alter it or copy it into another chat (`src/envelope.ts`). Replies, edits, reactions, renames, profile cards and the hidden chat's notes are all messages of their own kinds in the same log.
- **Pictures.** A picture is shrunk and re-encoded on the sender's device, which removes location and camera details, then encrypted with a key of its own. An animated GIF up to 2 MB goes as it is instead, so it keeps moving, with its comments and editors' metadata taken out (`onlyPictures` in `src/image.ts`). The message carries the file's hash, that key and a tiny preview; the file travels separately and is fetched by hash from any member who has it, or from our relay, which keeps it (still sealed, in pieces, under a topic of its own) for 30 days for members who are away (`src/file-store.ts`).
- **Sync.** When members connect, they compare how much of each author's (and device's) log they hold and send each other what is missing, so history spreads through whoever is online. Chats that are not open are swept briefly on launch and on return to the app (`src/background.ts`). When the app returns from the background it checks its connections and rejoins if they have died.
- **The relay's store.** Each message is also posted to our relay as a Nostr event tagged with the chat's store topic, which only members can work out, and locked a second time to the members' own keys (`src/store-seal.ts`), so someone holding only a chat's secret cannot read it. The relay keeps it for 30 days, or less if asked, and hands it to whoever asks for that topic (`src/mailbox.ts`, `worker-relay/`). Something left with a cancel tag (the hash of a key) is deleted early for whoever shows that key.
- **Counts for the developers.** The relay keeps daily totals of how much it is used (connections, messages stored, notifications sent, and how many messages of each kind devices send it) and can count what it holds anyway (devices with notifications on, messages held, and its connections: all of them, how many addresses they come from, and how many sent anything in the last five minutes, which is about one per app open). None of it names a person, a device or a chat (`worker-relay/src/stats.ts`). The developers read these on a private dashboard.
- **Push.** A device registers its push subscription with the relay for its chats' topics, with a per-person tag so the writer's own devices are not woken. The relay sends an encrypted, VAPID-signed Web Push saying only which chat (`worker-relay/src/webpush.ts`).
- **Transport.** [Trystero](https://github.com/dmotz/trystero) finds peers through Nostr relays, which see only a hash of the room ID and password-encrypted connection setup. The list is pinned in `src/relays.ts`: our own relay and five public ones. Messages travel over WebRTC data channels, directly where possible and through Cloudflare's TURN relay otherwise; a small Worker (`worker/`) hands out short-lived TURN credentials behind Turnstile and a rate limit.
- **Storage.** Identity, chats, messages and files are kept in IndexedDB on the device (`src/store.ts`).

## Code map

| Where | What |
| --- | --- |
| `src/main.tsx`, `src/app.tsx` | Start-up, the front page, Settings, joining and the invite-only gate |
| `src/chat-screen.tsx` | One chat on screen: messages, composer, menus, invite panel |
| `src/session.ts` | One open chat's connection and sync; leaving messages with the relay |
| `src/background.ts` | Syncing chats that are not on screen; "stay connected" |
| `src/envelope.ts` | Message kinds and their signed, encrypted envelope |
| `src/keys.ts`, `src/identity.ts`, `src/membership.ts`, `src/chats.ts` | Keys, people, certificates, making and joining chats |
| `src/invite.ts`, `src/invite-room.ts`, `src/scanner.tsx`, `src/qr.tsx` | Invites, the room they are exchanged in, scanning and drawing codes |
| `src/remote-invite.ts`, `src/invites-view.tsx`, `src/standing-invite.ts` | Invites from afar, left on the relay, and the Invites sheet (testing) |
| `src/diagnose.ts` | The "Check what's held" report on a chat (testing) |
| `src/devices.ts`, `src/link-device.ts`, `src/link-view.tsx` | One person on several devices |
| `src/mailbox.ts`, `src/store-seal.ts` | Messages left with and fetched from the relay |
| `src/push*.ts`, `src/push-view.tsx`, `public/sw.js` | Notifications and the service worker |
| `src/store.ts` | IndexedDB storage, unread counts |
| `src/profile*.ts*`, `src/cards.ts`, `src/edits.ts`, `src/reactions.ts`, `src/image*.ts*`, `src/files.ts`, `src/file-store.ts`, `src/recorder.ts`, `src/voice-view.tsx`, `src/emoji*` | Profiles, edits, reactions, pictures, files left with the relay, voice messages, emoji |
| `src/sound.ts`, `src/sounds/` | Message sounds |
| `src/update.ts`, `src/install.ts`, `src/gate.ts` | Self-updating tabs, installing, the invite-only gate |
| `src/transport.ts`, `src/relays.ts`, `src/turn.ts`, `src/route.ts` | Finding peers, the relay list, TURN, the route indicator |
| `worker-relay/` | Our Nostr relay on Cloudflare: signaling, the 30-day message store, push |
| `worker/` | TURN credentials |
| `e2e/pair.spec.ts`, `e2e-android/` | Browser tests (desktop Chromium; a real Android phone) |
| `scripts/` | Local relay, relay probe, push keys, icons, emoji data, `claude-chat.mjs` |
| `BACKLOG.md` | Plans, decisions, open questions, services depended on |

## Develop

```sh
npm install
npm run dev      # local dev server
npm test         # unit tests (app, both workers, scripts)
npm run e2e      # browser tests, against a relay started on this machine
npm run e2e:android  # the same app on a real Android phone attached by USB (see below)
npm run build    # typecheck and build to dist/
npx tsc --noEmit # typecheck everything, tests and workers included
```

Every push to `main` runs the unit and browser tests and, if they pass, deploys to GitHub Pages (`.github/workflows/deploy.yml`). The site's `version.json` names the build that is live.

The Workers deploy separately, with `npm run relay:deploy` (the relay) and `npm run worker:deploy` (TURN credentials), after `export CLOUDFLARE_ACCOUNT_ID=…`. The relay's push key was made once with `node scripts/push-keys.mjs`, which puts the private half into the relay as a secret and writes the public half to `src/push-key.ts`; it refuses to run again without `--replace`, which would stop every existing subscription.

`node scripts/claude-chat.mjs` is someone on snrdlr from the command line: a headless browser with its own saved profile in `.claude-chat/` that can `join` a chat from an invite link, list its `chats`, change the `name` it goes by, `say` something in one, and `listen` in a direct chat, printing each new message from the other person as a line of JSON (pictures are saved to `.claude-chat/inbox/`). While it listens, `say` hands it the reply. This is how the developer talks to Claude over snrdlr: a Claude Code session runs `listen` in the background and treats each line as a message from the developer. `listen --group` does the same in a group, where anyone a member lets in can write, so each line also carries `from` (the name they go by) and `author` (the start of their id, which only their key can sign for); it is meant for a separate profile (`SNRDLR_PROFILE`) run by a session that can change nothing, never the developer's own.

For manual testing in desktop browsers without touching public relays, run `npm run relay` in one terminal and `npm run dev:local` in another. The local relay (`scripts/local-relay.mjs`) is in-memory and unauthenticated, and only listens on localhost.

`npm run e2e:android` drives Chrome on an Android phone, paired with a desktop browser on this machine. It needs `adb` (`brew install android-platform-tools`), USB debugging allowed for this computer, and the phone unlocked on the same Wi-Fi. To stop the phone locking mid-run, turn on Settings → System → Developer options → Stay awake, which keeps the screen on while it is plugged in. The phone loads the test build through a USB tunnel as `http://localhost`, so its storage for the live site is untouched; Chrome on the phone is restarted, and its other tabs reload when next visited. It covers joining and inviting, history across a reload, catching up after the home screen, unread counts, direct chats, the on-screen keyboard, and a Wi-Fi drop. It cannot scan a code with the camera.

`npm run probe` measures the public Nostr relays in `scripts/relay-candidates.json`, to choose which ones the app should use. For each relay it makes two connections and posts one short-lived event the size of a real connection setup, then hangs up. It will not probe a relay again within three hours, backs off to daily or weekly when one fails, never connects to one that says it needs a login or payment, and stops for good if a relay twice asks it to slow down. `.github/workflows/probe-relays.yml` runs it every six hours and keeps the results on the `probe-data` branch; `npm run probe:report` prints both sets.

To try it on phones, serve it over HTTPS (for example the GitHub Pages deploy in `.github/workflows/deploy.yml`), start a chat on one phone and scan the code with the other.

## Credits

Snrdle and groovy sounds by the Unknown Snerdler.

## License

MIT
