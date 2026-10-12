# Open items

Things noted along the way that are not part of the current phase. The phased plan itself lives in the proposal doc.

## Features requested

- **Sounds** when sending or receiving a message.
  - Browsers only allow audio after a tap, so the first sound needs unlocking on a user gesture.
  - Only works while the app is open; notifications when closed are Phase 6 (push).
- **Names and nicknames.**
  - A real name for each user, and a chat name set by whoever creates the chat. Both exist today; neither can be changed after creation.
  - Rename a chat in progress. Needs a new message type (`rename` in the proposal) so every member sees the new name, and a rule for who may rename.
  - Local nicknames for users and chats, set on your own device and never sent to anyone.
- **Tell other members when someone leaves a chat.** Leaving currently only deletes the chat from your own device.
- **Message context menu** (hover on desktop, press and hold on touch):
  - Reply. See "How reply would work" below.
  - DM this user. The proposal's default is in-person pairing only for v1; starting a DM from inside a group needs each member's X25519 public key, which profile messages do not carry yet.
  - User info.
- **Inviter approval.** Optionally have the inviter confirm each joiner by name. Left out on purpose for now: while a code is showing, everyone who scans it gets in, and it is the inviter's job not to be photographed.
- **User profile.** Optional fields beyond the name, kept on the device, with a per-chat choice of whether to share it when joining a new chat. Profiles are already posted per chat, so the choice fits the current design.

### How reply would work

A reply is an ordinary message whose encrypted payload also names the message it answers, by author and sequence number. The app shows a quoted snippet above the reply and jumps to the original on tap. If the original is not on this device (not synced yet, or sent before you joined), it shows "original message not available". Because the reference is inside the signed payload, nobody can re-point a reply at a different message.

This changes the message format, so it needs a rule for how older app versions treat message types they do not know.

## Notifications on iPhone without deciding up front

Goal: people start chatting in Safari with no install step, and can turn on notifications later. iOS only delivers notifications to an app installed to the Home Screen, and that app's storage is separate from Safari's. Android needs none of this. Belongs with Phase 6.

Two candidate designs:

- **Split.** Safari stays the real app; the installed part only receives notifications.
  - For: camera scanning keeps working, so no in-app scanner is needed.
  - Against: tapping a notification opens the installed part, and a second tap is needed to reach the chat in Safari; the two halves must be linked once, by a pasted code or a link, so the Safari side can register the subscription; Safari's 7-day storage wipe still applies.
- **Migrate (preferred).** Start in Safari; on "Turn on notifications", guide the person through Add to Home Screen and move their identity and chat secrets into the installed app. History returns through sync.
  - For: notifications open the chat directly; the 7-day wipe no longer applies.
  - Against: the installed app needs its own way to join later chats (the Phase 3 in-app scanner, or pasting an invite link); a one-time transfer step.

To test on a real iPhone before choosing:

- Can an installed web app open a link in Safari proper, or only in an in-app browser view? The split design depends on it.
- When a site has a manifest, does Add to Home Screen keep the current address, fragment included? If so, the keys could be carried across without a paste, at the cost of leaving them stored in the icon. Otherwise the transfer is "copy a code in Safari, paste it in the installed app".

## Engineering follow-ups

- **Rest of Phase 4.** Invite certificates and handshake verification, DMs, and "add someone" starting a new group.
- **Phase 3 (installable app, in-app scanner) is postponed** until just before push notifications, which are what make installing worthwhile on iOS.
- **Sync resends around a permanent gap.** If one of an author's messages is held by nobody online, everything they wrote after it is offered again on each 30-second sync round. Rare, and only costs bandwidth; fix by having the vector list what is held beyond the gap.
- **Sync sends duplicates in large groups.** A returning member asks every connected peer for what it lacks, and each of them answers. Fine for a handful of people; worth narrowing later.
- **Trystero does not fully leave a room left within about a second of joining.** The room keeps answering newcomers. The app works around it (closed invites refuse requests; leaving is delayed until the join settles). Worth reproducing in isolation and reporting upstream.
- **Pin a vetted list of Nostr relays.** The app uses Trystero's default list; one public relay rate-limited us during testing.
- **Automatic TURN cut-off.** A scheduled check that deletes the TURN key if usage passes a threshold, as a backstop against a large bill. Wanted before sharing the app widely.
- **Two tabs of one chat on the same device.** Each tab only shows the other's messages after a reload.
- **Unknown message types.** Today an unrecognised type is dropped. Decide whether to store it for later display once the app is updated.
- **Run the browser test in CI.** It is hermetic now (local relay), so it could gate deploys.
- **Custom domain.** Keys and history are tied to `myklemykle.github.io`; moving later strands existing installs.
- **Bot access (Phase 5).** The proposal says the bot gets the room ID but not the message key; it will also need the signaling password, and a way past the certificate check.

## Testing still owed

- Reconnect after backgrounding on a real iPhone: lock the phone or switch apps for a minute, come back, and check the chat recovers and catches up without a reload.
- Phase 1 and Phase 2 exit tests on Android.
- History surviving on iOS over several days, in a Safari tab and installed to the Home Screen.
