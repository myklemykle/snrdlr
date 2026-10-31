# Open items

Things noted along the way that are not part of the current phase. The phased plan itself lives in the proposal doc.

## Features requested

- **Sounds: built.** A random sound from the chosen set plays when a message or picture is sent or arrives, in the open chat and (on a stay-connected computer) in the others. Settings offers the sets, which are the folders in `src/sounds/` ("snrdl", the default, "plink", and "groovy", added 15 October 2026), and "shhhhh" for silence. Still open:
  - Nothing plays while the app is closed or the phone is locked; a notification (built 14 October 2026) uses the system's own sound instead.
  - One pool of sounds for both directions. Separate sets for sent and received, a per-chat mute, and a volume control are possible later.
  - Not yet heard on a real iPhone or Android phone; check that the silent switch mutes it on the iPhone.
  - Each set has its own volume in Settings, from 0 to 200%. Defaults: snrdl 10%, plink 50%, groovy 10%. A device where the slider was moved keeps its own level. The low snrdl default suggests the files themselves could be re-levelled.
  - The sound for sending plays as the message is sent (since 14 October 2026; it used to wait until the message reached another member's device, which testers found confusing). A received message sounds only if it was written in the last two minutes, so history loading into a chat is silent.
  - **Delivered marks.** Each device still answers what it receives with a short note (how many messages it holds from that author). That report could show, per message, that it has reached someone (and later, everyone). Not built.
  - The snrdl and groovy sounds are credited to the Unknown Snerdler in the README (their maker asked to be credited anonymously); under what licence they are shared is not recorded.
- **Settings.** A window opened from the gear on the home screen. It holds the sounds, joining someone (scan or paste), installing, adding a device, the stay-connected switch and the version line. The front page keeps only Chat with one person, Start a group and the chat list (14 October 2026). Candidates to add: storage used.
- **Names and nicknames.**
  - A real name for each user, and a chat name set by whoever creates the chat. Both exist today; neither can be changed after creation.
  - Rename a group: built. Any member can, from the pencil beside the chat's name; everyone gets the new name and a line saying who changed it. Direct chats stay named after the other person. Open: two groups can now end up with the same name on one device.
  - Local nicknames for users and chats, set on your own device and never sent to anyone.
- **Swipe to delete in the chat list.** On iOS, swiping a list row left to reveal a delete action is the standard convention; use it for leaving a chat, alongside or in place of the Leave button. Android has no single equivalent: swipe-to-dismiss and long-press-to-select are both common there.
- **Tell other members when someone leaves a chat.** Leaving currently only deletes the chat from your own device.
- **Message context menu** (a button beside the message on desktop, press and hold on touch). Built, with emoji reactions, reply, edit and a copy button in it. Still to add:
  - DM this user. The proposal's default is in-person pairing only for v1. Profile messages now carry each member's X25519 key, so starting a direct chat from inside a group is possible without meeting.
  - User info.
- **Reactions: follow-ups.** One reaction per person per message; six quick ones, or any emoji from the app's own picker (a page cannot open the system's emoji keyboard). Open:
  - **Skin tones.** The picker offers each emoji in its default colour only. A pasted emoji with a skin tone works. Add a press-and-hold choice and remember the preference.
  - **Search is by English name only** ("party popper"), with no keywords ("celebrate") and no other languages.
  - The picker leaves out emoji newer than the device can draw, by a drawing test that has only been checked in desktop Chrome. Check on the iPhone and the Android phone that no empty boxes appear and nothing obvious is missing.
  - On an iPhone, check that the picker sits above the keyboard when its search box is in use.
  - Press and hold replaces the phone's own text selection on messages, so the menu's copy button copies the whole message only.
  - The Android automated test for reactions is written but has not been run.
  - ~~Offer the picker from the message box on desktop too, where there is no emoji keyboard a click away.~~ Done 2026-10-30: an emoji button beside the box. Since 2026-10-31 on computers only; phones get snerds by typing their code.
  - **Snerds, the snrdlr bird emoji** (asked 2026-10-30, built the same day; renamed from "bird" 2026-10-31). Nine drawings of the icon's bird, redrawn as SVG from the PNG since the original vector art was not to hand; the owner chose the expressions and dropped "happy" and "bemused" from the draft. Decision: each is sent as a text code (`:bird-nap:`), not a private-use character or a new message kind, so it fits in text, reactions and profile icons as they are, and an app that predates a bird shows readable words rather than an empty box. 2026-10-31: the owner asked to have them in the phone's emoji keyboard instead of a button of their own. A web page cannot add to the system keyboard (only an installed keyboard app can), so instead they are offered above the keyboard as their code is typed (as Slack and Discord do), and two (look at you, puzzled) joined the quick reactions; the codes became `:snerd-…:`, and the first day's `:bird-…:` are still drawn. Before this, an older app refuses a reaction or profile icon that is a bird code (it is not a single emoji to it). Open: if the original SVG turns up, redraw the set from it.
  - Reactions will apply to images once those exist.
- **Inviter approval.** Optionally have the inviter confirm each joiner by name. Left out on purpose for now: while a code is showing, everyone who scans it gets in, and it is the inviter's job not to be photographed.
- **User profile.** First pass built: from the front page, a person sets an icon (emoji or tiny photo), a colour that tints their messages, one contact (email, phone, Instagram or other) and a larger photo, and can change their name. All optional but the name. Each part (icon, colour, contact, photo) has its own setting: shown in every chat, or only in the chats where that part is turned on, from your own profile inside the chat. Others open it from a message's menu or the top of a direct chat. People who show nothing get their initial on a colour of their own, so two people with one name look different. Open:
  - A change made on the front page reaches each chat when that chat next connects, not at once (a stay-connected tab can take a couple of hours).
  - Taking a profile back only stops showing it; what was shown stays in other members' history. Say so more plainly, or build real deletion.
  - No line in the chat when someone changes their name; the "joined" line keeps the old one.
  - **Own messages in your own colour** (requested 14 October 2026; built 16 October). In a chat where you show your colour, your own messages are in it, darkened only as far as white words need (contrast 4.5:1): red and purple stay as they are; yellow becomes a dark olive.
  - The tiny photo is cut from the middle of the picture; no cropping tool.
  - The profile, name and photo included, is the same on all of a person's devices since 16 October 2026: the one saved last on any of them is taken up by the others, through the hidden chat; the photo goes in 32 KB pieces. A profile saved before then travels once it is next saved.
- **Biometric lock.** Touch ID, Face ID or the phone's own biometrics to open the app, so someone holding the unlocked phone cannot read the chats. See "How a biometric lock would work" below.

### How a biometric lock would work

A web app cannot call Touch ID or Face ID directly; it asks through WebAuthn (a passkey made on the device, with user verification required), and the phone shows its own biometric prompt, falling back to the passcode.

- **Screen lock only.** The app refuses to show anything until the check passes. Stops a casual snoop, but the keys and history sit unencrypted in storage, so it does not stop anyone who can inspect the browser's data.
- **Encrypted storage (the real thing).** WebAuthn's PRF extension returns a secret only after a successful check; use it to encrypt the identity keys and chat secrets at rest. Needs a recent browser (Safari 18+, current Chrome), so test on real devices first.

To settle when building it:

- Opt-in, offered after someone is already chatting, never at first launch.
- When to lock again: on every return to the app, or after some minutes away.
- While locked, background sync cannot run, and (Phase 6) a notification cannot show message text.
- There is no recovery: if the passkey is lost, so are the chats. Same as losing the device today.
- The passkey is tied to the site's address, another reason to settle the final address first.

### How replies work (built)

A reply is an ordinary message whose encrypted payload also names the message it answers, by author and sequence number. The app shows a quoted snippet above the reply and goes to the original on tap. If the original is not on this device, it says so. Because the reference is inside the signed payload, nobody can re-point a reply at a different message. A reply in words travels as a kind of its own (`reply`), which an older copy of the app keeps and reads once it has updated; a picture that is a reply just carries one more field.

Open:
- Swipe a message sideways to reply, as other chat apps do on phones.
- Loading a quoted message that is not on this device.

### How editing works (built)

An edit is a message of its own that names one of the author's earlier messages by its number and gives the new words. It can only name the author's own messages, so nobody can change what someone else said. The latest edit counts; the message shows "edited" beside its time. Edit is in the message menu on your own messages; the words go into the message box with a Save button, and what you were typing comes back afterwards. On a keyboard, the up arrow in an empty message box edits your last message. A picture's caption can be added, changed or removed the same way.

Open:
- The earlier wording stays in every member's log; the app just does not show it. Decide whether to show an edit history, and say plainly somewhere that editing does not unsend.
- Deleting a message (the same mechanism, with the same caveat).
- A time limit on editing, if wanted.
- An older copy of the app keeps an edit unseen until it updates.

## Images and audio messages

- **Pictures from links** (built 17 October 2026): the first link in a message that points at a picture is shown below it, loaded by each reader's device from the site that has it, which so learns their address and when they looked; Settings can turn it off. A sender-side preview (as Signal does) would need our own server to fetch pictures, since a page cannot read another site's pictures; worth it only if the privacy cost matters to people.

### Pictures: built

A picture message is a small signed message holding the file's hash, size, dimensions, a key of its own and a tiny preview. The file is encrypted with that key, kept in its own table, and fetched automatically by hash from any member who has it. Before sending, the device shrinks the picture to 1600 pixels on its longest side and re-encodes it as a JPEG, which removes location and camera details. Several can be sent at once (up to ten), with a caption on the first; they can be chosen, pasted or dropped. Reactions work on them. A stay-connected computer fetches every picture, so it can pass them on.

Still open:

- **Not yet tried on real phones.** Choosing from the camera and the photo library, a real photo's rotation, HEIC photos from an iPhone, and saving through the share sheet. The Android automated test is written but has not been run.
- **Animated GIFs become still pictures**, because shrinking redraws them. Keeping animation means sending the file untouched, with a size limit.
- **No progress bar.** A picture shows its blurred preview and "Loading…" until it is all here.
- **The viewer is basic**: no pinch to zoom of its own, no swiping between pictures, and Android's back button leaves the chat instead of closing it.
- **No "original size" option**, and nothing bigger than 2 MB once encrypted is accepted.
- **Pictures are kept until the chat is left.** Add a "storage used" view, and a way to delete a picture from this device.
- **iPhone storage.** Safari can clear a site's data after seven days without a visit unless the app is installed to the home screen (Phase 3). Pictures make that loss more noticeable.
- **A device that never gets the file** keeps asking every half minute while connected. Fine for now; a file nobody has any more should eventually show as gone.
- **Sending is all-at-once per picture**; a connection that drops midway starts that picture again.

### Voice messages: built 17 October 2026

Recorded in the composer (the Send button is a microphone while the box is empty), listened to and then sent or deleted, up to five minutes. AAC in MP4 where the browser can record it (Safari, recent Chrome) so iPhones can play everything; Opus in WebM or Ogg otherwise (Firefox). The sealed recording travels like a picture's file, and is left with the relay for members who are away. Played with play/pause, a position that can be dragged, and 1×/1.5×/2×.

Still open:

- Safari on an iPhone refused the microphone with InvalidStateError (17 October 2026): the page had told iOS its audio was "ambient" (for message sounds that follow the silent switch), and an ambient page cannot record. Recording now switches to "play-and-record", and playing a voice message to "playback" (heard with the silent switch on), then back.
- A waveform picture; hold-to-talk as a shortcut; playing one message after another.
- A recording in a format this device cannot play says nothing useful yet.

### Audio: to do

- Audio formats: iPhones and Android/desktop browsers record differently; test on real devices that each can play the other's.
- Audio can use the same file transfer as pictures.
- The bot (Phase 5) would need to hold encrypted files as well as messages. Each file already has its own key, so it can.

## Notifications on iPhone without deciding up front

Goal: people start chatting in Safari with no install step, and can turn on notifications later. iOS only delivers notifications to an app installed to the Home Screen, and that app's storage is separate from Safari's. Android needs none of this. Belongs with Phase 6.

Two candidate designs:

- **Split.** Safari stays the real app; the installed part only receives notifications.
  - For: camera scanning keeps working, so no in-app scanner is needed.
  - Against: tapping a notification opens the installed part, and a second tap is needed to reach the chat in Safari; the two halves must be linked once, by a pasted code or a link, so the Safari side can register the subscription; Safari's 7-day storage wipe still applies.
- **Migrate (preferred).** Start in Safari; on "Turn on notifications", guide the person through Add to Home Screen and move their identity and chat secrets into the installed app. History returns through sync.
  - For: notifications open the chat directly; the 7-day wipe no longer applies.
  - Against: the installed app needs its own way to join later chats (the Phase 3 in-app scanner, or pasting an invite link); a one-time transfer step.

**Built (the Migrate design), 13 October 2026; replaced 14 October.** The app is installable: a manifest, icons, and a service worker that opens it with no network (the page is always fetched fresh when there is one, so the worker never holds back a new version). Chrome on Android and on computers gets an Install button; there the installed app shares the browser's storage. The installed app joins chats with its own scanner ("Scan a code") or "Paste a link". The copy-and-paste move into the installed app was taken out again: people would scan codes with the iPhone camera, which always opens Safari, and end up with two separate snrdlrs. It is replaced by one person on several devices, below.

**Chosen design, 14 October 2026: the split, made possible by several devices.** Tested on an iPhone with the lab page (`/lab/`): from a Home Screen app, ordinary links and `window.open` stay inside the app, but an `x-safari-https://` link opens Safari itself, from a link or from code. Real Web Push arrives (Apple's push service accepted pushes from a test script). Tapping a notification can open the app, and the app can then send the person on to Safari quickly; a notification cannot open Safari directly (it stays in the app). Plan: Safari holds the chats; the Home Screen app is another device of the same person that receives notifications and forwards taps to Safari ("Open in Safari" when adding it). Android and computers need none of this.

Still to check on a real iPhone:

- Adding the Home Screen app with "Add this app to my snrdlr", then "Open in Safari", then "Add it" in Safari, then switching back.
- The camera opens inside the installed app and reads a code from another phone's screen.
- Sounds, pictures and the keyboard behave the same installed as in Safari.

Open:

- The app icon is the red bird (15 October 2026), drawn from `scripts/icon-source.png`; regenerate the sizes with `node scripts/make-icons.mjs`. A Home Screen app already installed keeps its old icon until it is removed and added again.
- Old cached files are dropped only by count; revisit if the cache grows.
- The lab page (`lab/`, `lab-out/`, `public/lab/`) is a throwaway; remove it once a tapped notification is seen to hand off to Safari on a real iPhone.

**Notifications built, 14 October 2026.** Settings → Notifications. A device registers its push subscription with our relay for its chats; when a message just written is left with the relay, the relay pushes to every member's devices except the writer's own, and to none of a person's devices while they are actively using snrdlr on one (the page tells the relay every 30 seconds while it is visible and touched in the last two minutes). A notification names the chat, never the message; each chat has one notification, "New message", replaced by the next (it counted messages until 15 October 2026, but the count only grew: whether messages were read, especially in Safari, is never known where notifications are shown). In the iPhone Home Screen app a tapped notification can open the chat in Safari ("Open them in Safari, where you use snrdlr"). Verified in desktop Chrome through Google's push service; not yet on an iPhone or Android. Known gap: the Home Screen app only registers chats it knows, so a chat joined in Safari is covered once the app has been opened since.

**Tabs piling up in Safari, 31 October 2026.** Every notification tapped in the Home Screen app opens Safari in a new tab (an `x-safari-` link always does; a page cannot pick an existing tab), and each older one steps aside, so Mykle had a column of "snrdlr is open in another tab" pages. Now a stepped-aside tab on an iPhone (in Safari, not the Home Screen app) closes itself, at once and whenever it is looked at again. Safari only lets a page close itself when it has nothing to go back to, which is true of a tab opened for a notification but not of one used for more than one page; those still wait, as before. Not yet seen on the iPhone.

**Open bug, 30 October 2026: blank Safari tab after the hand-off.** Mykle tapped through from the Home Screen app to Safari; Safari opened a new tab that stayed blank, also after a reload. Not reproduced: opening a chat's address in a second tab works in desktop Chrome. (Playwright's headless WebKit hangs as soon as a chat opens, before and after the bird emoji release alike, so it cannot be used to test this.) Blank means the chat screen threw while drawing, or reading the chat from storage failed; neither showed anything. Now a failure to draw shows "Something went wrong showing this", what went wrong and the version, with Reload and Go to the chat list, and a chat that cannot be read goes back to the list with a note. Mykle's answers: a notification for a direct chat, probably; Safari already had a snrdlr tab, which was fine afterwards; it has happened before and does not happen every time. Next: get that text from the iPhone when it happens again.

## One person on several devices (built 14 October 2026)

Every device of a person holds the same keys. Each device numbers its own messages: a message is named by its author, the device that wrote it (an 8-byte tag sealed into the message; a person's first device has none) and that device's number. Sync counts each device separately. Edits, reactions and replies name the device too; "latest" among a person's messages is by the logical clock.

The devices keep in step through the person's own hidden chat (`src/devices.ts`), worked out from their keys: each device says there which chats it holds (with their keys) and which it has left, and takes up what the others say. It syncs like any chat, directly or through the relay's store, and each chat is mentioned again every 20 days so the store keeps the list.

Adding a device (`src/link-device.ts`): either device shows a code (QR or link, 10 minutes, one-time token). The new device leaves a request with a fresh public key at a place on the relay's store worked out from the token; both devices show a six-digit number from the token and that key; on "Add it" the existing device leaves the keys there locked to that key, and picks the new device's tag. The other devices show a notice when a device they did not add appears. A browser that had used the old copy-and-paste move becomes a second device of the person when it next opens.

Open:

- A lost device cannot be removed: it holds the keys. The only remedy is a new identity. Removing a device needs separate device keys signed by a personal key.
- In the device-showing-the-code direction (`#device1.n.`), someone who sees the code could hand the new device keys of their own; the new device would become them. It cannot steal anything, but is confusing. Could be closed by having the new device check the existing device's signature.
- A device added later gets each chat's history from the members or the relay store (30 days), not from the person's other devices' stores in bulk.
- Sounds are per device. (The profile is shared since 16 October 2026, through the hidden chat.) (Unread counts are shared since 14 October 2026: each device says in the hidden chat, per writer's device, the latest message it has shown, and the others stop counting those. A chat newly taken up from another device no longer counts its history as unread.)
- Where a chat was scrolled to is still per device.
- A chat left on one device while it is open on another's screen is let go when that screen is closed.

## Developer visibility and dashboard

Wanted: a developers-only page showing who is using the app and how much, and in particular how much of the TURN allowance is used as media features and users arrive.

What it could draw on:

- **TURN usage**: relayed gigabytes this month against the limit, by day, from Cloudflare's analytics. The Worker already stores the month's total every ten minutes for the spending cap.
- **Worker and Turnstile analytics**: credential requests per day, by country and browser; challenges passed and failed; rate-limit refusals.
- **Alerts**: tell the developer when the spending cap trips or the usage check stops working.
- **Message delivery times** (requested 14 October 2026): how long messages take to reach the other members, directly and by way of the relay, and how often they wait for someone to come back. Each device already answers what it receives with a short note, which says when a message reached someone; how to gather the times without telling the developer who is talking to whom is to be decided, along with the rest of this section.

"Who the users are" needs deciding before building, because today the app tells its developer nothing, on purpose:

- **A news channel everyone joins automatically** would show the developer every user's name and key. Built as an ordinary group it would also show every user to every other user, and connect their devices to each other, revealing addresses. If wanted, it needs to be a different thing: developer-to-user only, with members hidden from each other.
- **One-way news** (a signed file on the site that the app reads) reaches everyone and reveals nobody. It gives no user count.
- **An anonymous count** (the app tells the Worker "one device opened today", with no identity) gives numbers without names.
- Whatever is chosen, say so in the app; "no account, nobody in the middle" is the pitch.

Where it lives: a page served by the Worker behind a login (Cloudflare Access is free for a few users), not part of the public app.

**Decided 15 October 2026:** the dashboard is its own Worker in a private repository, at its workers.dev address behind Cloudflare Access (Google sign-in), with the Worker also refusing anything without a valid Access sign-in; optionally `dash.mykle.com` redirects there from Namecheap (mykle.com's DNS is not on Cloudflare). It shows Cloudflare's usage and cost figures for both Workers and TURN, daily totals the relay keeps (messages stored, notifications sent, connections), and, as the first estimate of users, the number of devices with notifications turned on. A daily anonymous check-in is a possible later step.

- **A plain-language FAQ for users** (requested 15 October 2026), including exactly what snrdlr promises about privacy: what the relay, Cloudflare, Apple and Google can and cannot see, what the developers can see (only the counts above), and how long anything is kept.

## Services snrdlr depends on, and who pays

Everything outside the users' own devices. To be kept complete: add a row whenever a new outside service is introduced.

### Needed for the app to work

| Service | What it does | Run by | If it is down | Cost today |
|---|---|---|---|---|
| GitHub Pages | Serves the app's files | GitHub | Nobody can load the app. Chats already open keep working until the page is reloaded | Free |
| Domain `snrdlr.net` and its DNS | The address | The registrar (its name servers) | Same as Pages. Whoever controls the domain controls what users load | Yearly registration |
| TLS certificate | HTTPS, without which browsers refuse the app's features | Let's Encrypt, through GitHub | Same as Pages | Free |
| Nostr relays, public | Devices find each other | Volunteers (five today, three later) | Nothing, while ours is up | Free, on others' goodwill |
| Nostr relay, ours (`snrdlr-relay`) | The same, as the one relay every version of the app shares | Us, on Cloudflare Workers and Durable Objects | Nothing, while a public one is up. With all relays down: no new connections; existing ones carry on | Free tier |
| STUN servers | Each device learns its public address, needed for a direct connection across networks | Google and Cloudflare (Trystero's defaults) | Only same-network and TURN-relayed connections form | Free |
| TURN relay | Carries traffic when a direct connection is impossible | Cloudflare Realtime | Devices on restrictive networks cannot connect | Free to 1,000 GB a month, then $0.05 per GB; capped at 800 GB by our Worker |
| TURN credentials Worker (`snrdlr-turn`) | Hands out short-lived TURN credentials; uses Cloudflare's rate limiter, key-value store, scheduler and analytics API | Us, on Cloudflare Workers | As TURN down | Free tier |
| Turnstile | Bot check in front of the Worker | Cloudflare | As TURN down | Free |

### Planned

| Service | For | Likely cost |
|---|---|---|
| Blind bot | Holds messages for members who are offline | A small server, about $5 a month, or a member's own computer |
| Push services (Apple, Google, Mozilla) | Notifications; each browser uses its maker's service and there is no choosing | Free to send |
| Push sender | Something of ours that asks those services to wake a device | A Worker or the bot's server |

### Behind the scenes

Not used by a running app, but the project stops without them: the GitHub account (source, automated tests, deploys, the relay probe), the npm registry (the libraries, at build time only), and the Cloudflare account. The GitHub account, the Cloudflare account and the domain are the three things that must not be lost or taken over; see "Protect the publishing account".

### Paying for it

- Today the only bill that grows with use is TURN, and only past 1,000 GB a month. Text chat will not get near that; images and audio over the relay could.
- Costs that would be real with many users: TURN traffic, the bot's server and storage, and our relay if it outgrows a free tier.
- The message store's open points: anyone who knows a chat's topic (that is, holds its secret) can fill that chat's allowance with junk and push real messages out; members are not told when a message was dropped for space; a member whose key the sender had not yet seen gets that message from another device instead of the store; pictures are not stored, only messages; Durable Object storage beyond the free allowance is billed (5 GB free; reads and writes have daily free amounts too).
- To decide: how users pay their share. Options to think through: voluntary donations, a paid always-on bot per group (the group that wants offline delivery pays for its own), or groups bringing their own relay and bot. The design already allows the last: a fork or a group can point at its own services.
- Anything that takes payment adds a new centralized piece (a payment processor, and some record of who paid) and must not link a payer to their chats.

## Forks and other domains

Open question: if someone forks the project and hosts it elsewhere, should people on the two sites be able to chat, and how?

What already carries across, and what does not:

- **The wire is not tied to a domain.** Room IDs and keys come from the chat's secret plus the app ID (`snrdlr-v2`). Two sites with the same app ID, message format and at least one Nostr relay in common can already talk.
- **Identity and history are tied to a domain.** The browser keeps them per site address, so the same person on two sites is two different people with no chats in common.
- **An invite code is a link to the inviter's site.** Scanning it opens that site, not the one the scanner normally uses, and gives them a fresh identity there.
- **The TURN Worker only serves listed sites.** A fork needs its own, or its users get direct connections only.

Policy to decide:

- Whether to welcome interoperating forks, tolerate them, or keep them out by treating the app ID as private. A fork that changes the app ID is simply a separate network.
- A member running a hostile fork can leak a chat. That is no worse than a member with a modified copy of this app today, but people may trust "the same app" more than it deserves. Decide whether to show which site each member is using; it can only be self-reported.
- Who owns the protocol: a written spec with a version number, and a rule for how sites on different versions treat each other. Unknown message kinds are already kept, which helps.

Ways to build a bridge:

- **Site-neutral invites.** Make the code's payload usable by any compatible site: a "use my usual app" choice on the landing page, a pasted code, or the Phase 3 in-app scanner.
- **Moving an identity between sites.** Export on one, import on the other; history returns through sync. The same transfer step as the "Migrate" notification design below, and as moving to the final address.
- **Linking two identities as one person.** Each key signs the other, so members see one name rather than two. Needs a new message type.
- **Shared relay list.** Sites must agree on at least one relay; goes with pinning a vetted list.

Cheapest thing to do early: settle the final address before there are users to strand, and write the protocol down.

## Engineering follow-ups

- **Intermittent test: "a computer set to stay connected passes messages…"** (16 October 2026). Failed three times in a cluster (60 s timeout), then passed fourteen times running. It started after "stay connected" tabs became passive (they wait for others to announce), It then failed in CI too and stopped a deploy. Every failure ended at the test closing the first tab right after it had begun reloading to step aside for the second; the test now waits for that reload to finish first. If it recurs, look at closing a tab mid-reload, and at whether a passive keeper is slow to reach people.
- **A relay holding a non-member's messages keeps offering them.** Phones refuse a message whose author has no certificate, but do not tell the sender, so it is offered again on every sync round. Only a blind bot could hold such messages. Costs bandwidth only.
- **Removing a member.** Still impossible: a member keeps the chat's secret and their certificate. Needs key rotation.
- **An uninvited device sees itself as connected.** Someone holding a stolen copy of a chat can verify the real members, so their own screen says "Connected", although the members ignore them and send them nothing.
- **Direct chat placeholder names.** If someone scans a "chat with me" code before choosing a name, the chat is called "Direct chat" until it is next opened or synced.
- **Keep the chat list fresh while it is on screen.** Chats that are not open only sync when the app is opened or returned to, so the unread counts do not change while you sit on the list.
- **Phase 3 (installable app, in-app scanner) is postponed** until just before push notifications, which are what make installing worthwhile on iOS.
- **Sync resends around a permanent gap.** If one of an author's messages is held by nobody online, everything they wrote after it is offered again on each 30-second sync round. Rare, and only costs bandwidth; fix by having the vector list what is held beyond the gap.
- **Sync sends duplicates in large groups.** A returning member asks every connected peer for what it lacks, and each of them answers. Fine for a handful of people; worth narrowing later.
- **Trystero does not fully leave a room left within about a second of joining.** The room keeps answering newcomers. The app works around it (closed invites refuse requests; leaving is delayed until the join settles). Worth reproducing in isolation and reporting upstream.
- **Pin a vetted list of Nostr relays.** The app uses Trystero's default list (five of about thirty hobby relays, picked by our app ID); one rate-limited us during testing, and the list can change under us when Trystero is upgraded, which would strand an older copy of the app on different relays. Plan: our own relay as the permanent anchor, plus three public ones.
  - **Probe: running.** `npm run probe` and a scheduled run every six hours measure 38 candidates (see the README). After about a week, pick three that always delivered, from different operators.
  - **Our own relay: built and in the list.** `wss://snrdlr-relay.snrdlr.workers.dev` (`worker-relay/`, deploy with `npm run relay:deploy`). Passes short-lived events (kinds 20000 to 29999) without storing them, and refuses a subscription that does not name its topics, so nobody can watch all activity. Since 14 October 2026 it is also the **message store**: it keeps sealed chat messages (kind 7467) for up to 30 days, at most 2,000 messages or 8 MB per chat (oldest dropped first), in the Durable Object's own SQLite database, and stops taking new ones past 1 GB in total. Each device leaves its own messages there as it writes them, locked a second time to each member's own key (`src/store-seal.ts`), so a copy of a chat's secret is not enough to read them; and collects what it missed whenever a chat opens or syncs in the background (`src/mailbox.ts`). Each event is signed with a key made for it and thrown away. What the relay learns: which chat topics are active, when, how much, and from which addresses. Open to anyone; limits per connection and per address. Runs on Cloudflare's free tier: 100,000 requests a day shared with the TURN Worker, where 20 incoming messages count as one request. Past that it fails until midnight UTC rather than billing, as long as the account stays on the free Workers plan.
  - **The list is pinned** in `src/relays.ts`: ours plus the five Trystero used to pick. Next: replace the five with the best three from the probe. Change at most one public relay per release so old and new copies always share one.
  - **Give the relay a permanent name.** Its address must outlive the Cloudflare account's `workers.dev` name. `relay.snrdlr.net` needs the domain's DNS to be hosted at Cloudflare (it is at the registrar now). Old copies of the app keep using the `workers.dev` address, so that one has to keep working too.
  - **One object holds every connection**, because any two devices must be able to meet. Good for a few thousand connections; beyond that it needs splitting, which the connection library's one-socket-per-relay design makes awkward.
  - **Usage is not watched.** Add the relay's request count to the developer dashboard, and warn well before the daily free limit.
- **TURN spending cap: tighten.** The Worker stops issuing TURN credentials once the month's relayed traffic passes a limit (800 GB), or if it has had no usage reading for six hours. Still open: credentials already issued work for up to four hours after the cap trips, so a hard stop would mean revoking the TURN key itself; and nothing tells the developer when the cap trips (see the dashboard below).
- **Invite-only: the app gate is built; a real gate is not.** A device that has never joined a chat by invite sees "snrdlr is invite-only" and can do nothing else. Joining through any working invite lets it in for good; devices that had a name or a chat before the gate are let in; developer mode skips it. It runs in the visitor's browser (`src/gate.ts`), so it stops people who merely find the address, not anyone who reads the code. A real gate would sit on the servers we pay for:
  - Every admitted device holds a random pass registered with our Worker. An inviter's device gets a one-time ticket from the Worker and hands it over with the invite; the newcomer trades it for a pass.
  - The Worker refuses TURN credentials, and our relay refuses connections, without a pass. A pass and everyone invited through it could be cancelled.
  - Costs: our server would hold a record of which pass invited which (anonymous, but a registry); inviting would depend on the Worker being up; the public relays do not check passes; forks are outside it entirely.
  - Build it only if strangers show up in the usage numbers. The TURN spending cap already limits what they could cost.
- **Invites from afar (testing only): decide before launch.** Built 18 October 2026, replacing the standing links, which never expired and could not be cancelled. With developer mode on, an Invites sheet (an envelope beside Settings on the front page) makes a link into a group, or for a direct chat, that lasts from 1 minute to 7 days and can be cancelled sooner, with nobody needing to be online when it is opened. What a joiner needs is sealed on the relay, kept only until the invite ends, and deleted at once on cancelling (the relay's new FORGET, allowed only to whoever holds the cancel key). Decided with the owner: a group link lets in everyone who opens it while it works; a direct-chat link works once and then closes itself; the person's devices all see and can cancel the same invites (shared through the hidden chat). Limits: cancelling stops new people but removes nobody, since whoever opened a group link holds its secret; removing members is separate work. Old `#s=` standing links no longer open. Before launch: keep it out of release builds, or offer it to everyone once member removal exists.
- **Group size.** Every device connects directly to every other, so a chat is comfortable to about 10 people and workable to perhaps 20. Sending one message to N others costs N copies out and N short acknowledgements back. What grows faster, in the order it would hurt:
  - **Direct connections**: N per device. Phones struggle somewhere past 10 to 20. Larger groups would need devices to connect to only some of the others and pass messages along.
  - **The idle check.** Every 30 seconds every device sends every other its full account of what it holds, about 70 bytes per member: roughly 8 KB per device per half minute at 10 others, 180 KB at 50. Fix: send a short fingerprint of the account, and the full account only when fingerprints differ.
  - **History scans.** Each account received makes the device scan the chat's whole history for what the other side lacks, and several other steps (ordering, numbering, redrawing) also walk the whole history per message. Fix: keep per-author indexes instead of scanning.
- **Updating while tabs are open: built.** Each build publishes `version.json`. An open tab checks it every ten minutes and whenever it comes back into view, and reloads itself once it is hidden or has been idle for five minutes and nothing is half done (a message being typed, pictures waiting to send, a code or picture on screen). It tries once per version; if that does not get it there, the home screen offers "Reload to update". A tab on an old storage layout still steps aside at once for a newer tab. The stay-connected section says how long the tab has been running and whether it restarted to update, so a self-update can be told from the browser discarding the tab. In developer mode, "Hold updates in this tab" keeps one tab on its version for a long test. Still open: GitHub Pages may serve the old `version.json` for up to ten minutes after a deploy; and a tab that reloads while hidden cannot play sounds until it is next tapped.
- **Two tabs of one chat on the same device.** Each tab only shows the other's messages after a reload.
- **Final address.** The app is at `alpha.snrdlr.net` while it is in testing, and nobody is promised their chats will last. Keys and history are tied to the address, so pick the permanent one (for example `snrdlr.net` itself) before anyone is; moving strands every install unless identities can be exported and imported.
- **Bot access (Phase 5).** The proposal says the bot gets the room ID but not the message key; it will also need the signaling password, and a way past the connection check. It cannot check authors itself, since it cannot read certificates; members do that when they receive what it stored.
- **Stay connected on desktop: built, needs a soak test.** A switch on the home screen of desktop browsers keeps every chat connected while the tab is open, so one awake computer passes messages between members who are never online together. One tab per browser does it (a second tab waits its turn), rooms are rejoined every two to three hours so relay credentials stay fresh, and connections are tested after the computer sleeps. Still open:
  - **Hours in a background tab are untested.** For the test, turn on developer mode and tick "Hold updates in this tab" so a deploy does not restart it; the status line shows how long the tab has run. Automated tests cannot reproduce Chrome slowing a hidden tab's timers or discarding it (Memory Saver). Leave the tab open overnight, hidden, and check the next morning that the status line still shows it connected and that a message sent to it overnight reached a third device. Do the same in Safari and Firefox.
  - If a browser does discard the tab, options are a pinned or separate window, a silent audio trick, or going straight to the bot.
  - The chat on screen is not rejoined on a timer, so a chat left open for more than four hours may be using expired relay credentials for new connections.
  - Nothing tells other members that an always-on device exists, or which one it is.

## From the first Android run (moto g power 2021, Chrome 131, 12 October 2026)

37 passed, 3 failed, 11 skipped or not run. Fixed since, and needing a retest on the phone:

- **Emoji keyboard covered the message box.** The taller keyboard overlapped the bottom of the chat. The page is now told to shrink with the keyboard.
- **A message sent while Android was away did not show.** Not reproduced. Two possible causes fixed: a message stored by another session of the same chat stayed hidden until a reload; and a device that had been out of touch numbered its next message just after the last one it had seen, so it appeared far up the history instead of at the end.
- **"Couldn't connect" while the other phone was simply asleep.** Reworded; the message still appears whenever one device in the chat cannot be reached.

- **Newest messages hidden when the keyboard opened.** Found by the automated phone run after the keyboard fix above: the log got shorter but did not stay scrolled to the end. Fixed, and covered by `npm run e2e:android`.

Automated on the phone since (`npm run e2e:android`, 7 scenarios, all passing on this phone): steps 2.1 to 2.6, 3.4 and 3.5 by link, 4.1, 4.2, 4.9, 5.1 to 5.3, 5.6, 7.1 to 7.3, 8.1, 8.2, 8.5, and a Wi-Fi drop. They run against the test build and a relay on the Mac, on one Wi-Fi network, so they say nothing about the live site, the public relays, TURN or mobile data.

Still open:

- **"Add someone" in a direct chat is confusing.** It reads as adding to this chat; it starts a new group. Rename it ("New group with Anne") or explain it.
- **Many connection-check page loads with no credential request after them** from the Android phone, seen in the Worker's log. The phone had four tabs of the app open at once, each connecting its own chats, which accounts for much of it. Each chat that connects also runs its own check at the same moment; they should share one.
- **Several tabs of the app on one phone.** Android opens a new tab for each scanned code, so tabs pile up, each holding connections. A message stored by one tab did not show in another (fixed for an open chat; the chat list still needs it). Built 16 October 2026 the other way round: the newest tab takes over and older ones step aside (`src/one-tab.ts`). Seen on iOS too (Mykle, 15 October 2026): Safari also ends up with several snrdlr tabs.
- **Not yet run:** emoji sizes (4.4), mobile data (6.2 to 6.5, the phone has no SIM), next-day persistence (9.1, 9.2), other browsers, incognito.

## Testing still owed

- Reconnect after backgrounding on a real iPhone: lock the phone or switch apps for a minute, come back, and check the chat recovers and catches up without a reload.
- Phase 1 and Phase 2 exit tests on Android.
- History surviving on iOS over several days, in a Safari tab and installed to the Home Screen.
