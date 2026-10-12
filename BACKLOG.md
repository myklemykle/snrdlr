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
- **Swipe to delete in the chat list.** On iOS, swiping a list row left to reveal a delete action is the standard convention; use it for leaving a chat, alongside or in place of the Leave button. Android has no single equivalent: swipe-to-dismiss and long-press-to-select are both common there.
- **Tell other members when someone leaves a chat.** Leaving currently only deletes the chat from your own device.
- **Message context menu** (hover on desktop, press and hold on touch):
  - Reply. See "How reply would work" below.
  - DM this user. The proposal's default is in-person pairing only for v1. Profile messages now carry each member's X25519 key, so starting a direct chat from inside a group is possible without meeting.
  - User info.
- **Inviter approval.** Optionally have the inviter confirm each joiner by name. Left out on purpose for now: while a code is showing, everyone who scans it gets in, and it is the inviter's job not to be photographed.
- **User profile.** Optional fields beyond the name, kept on the device, with a per-chat choice of whether to share it when joining a new chat. Profiles are already posted per chat, so the choice fits the current design.

### How reply would work

A reply is an ordinary message whose encrypted payload also names the message it answers, by author and sequence number. The app shows a quoted snippet above the reply and jumps to the original on tap. If the original is not on this device (not synced yet, or sent before you joined), it shows "original message not available". Because the reference is inside the signed payload, nobody can re-point a reply at a different message.

This changes the message format, so it needs a rule for how older app versions treat message types they do not know.

## Images and audio messages

Wanted after Phase 4. The proposal doc lists file transfer as a non-goal for v1, so this extends the plan. No foundation work is needed first, provided media stays out of the message log:

- A media message is a small signed message holding a reference: the file's hash, size, type, its own encryption key and a tiny thumbnail. The file is fetched separately, on demand, from any member who has it.
- Files get their own table in storage, and their own fetch-by-hash request next to sync.
- Depends on "keep message types the app does not recognise" (going into Phase 4), so older app versions do not lose the messages.

To settle when building it:

- Do the automatic TURN cut-off first; relayed media uses real data.
- Strip location and other metadata from photos, and downscale them, before sending.
- Audio formats: iPhones and Android/desktop browsers record differently; test on real devices that each can play the other's.
- The bot (Phase 5) would need to hold encrypted files as well as messages.
- Images first, then audio.

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

- **Check membership of message authors, not only of connections.** A message is accepted if its signature is valid, whoever its author is. Non-members cannot deliver anything today because members ignore their connections, but once a bot relays stored messages (Phase 5) the log itself should refuse authors without a certificate.
- **Removing a member.** Still impossible: a member keeps the chat's secret and their certificate. Needs key rotation.
- **An uninvited device sees itself as connected.** Someone holding a stolen copy of a chat can verify the real members, so their own screen says "Connected", although the members ignore them and send them nothing.
- **Direct chat placeholder names.** If someone scans a "chat with me" code before choosing a name, the chat is called "Direct chat" until it is next opened or synced.
- **Keep the chat list fresh while it is on screen.** Chats that are not open only sync when the app is opened or returned to, so the unread counts do not change while you sit on the list.
- **Phase 3 (installable app, in-app scanner) is postponed** until just before push notifications, which are what make installing worthwhile on iOS.
- **Sync resends around a permanent gap.** If one of an author's messages is held by nobody online, everything they wrote after it is offered again on each 30-second sync round. Rare, and only costs bandwidth; fix by having the vector list what is held beyond the gap.
- **Sync sends duplicates in large groups.** A returning member asks every connected peer for what it lacks, and each of them answers. Fine for a handful of people; worth narrowing later.
- **Trystero does not fully leave a room left within about a second of joining.** The room keeps answering newcomers. The app works around it (closed invites refuse requests; leaving is delayed until the join settles). Worth reproducing in isolation and reporting upstream.
- **Pin a vetted list of Nostr relays.** The app uses Trystero's default list; one public relay rate-limited us during testing.
- **Automatic TURN cut-off.** A scheduled check that deletes the TURN key if usage passes a threshold, as a backstop against a large bill. Wanted before sharing the app widely.
- **Two tabs of one chat on the same device.** Each tab only shows the other's messages after a reload.
- **Unknown message types.** Today an unrecognised type is dropped. Decide whether to store it for later display once the app is updated.
- **Custom domain.** Keys and history are tied to `myklemykle.github.io`; moving later strands existing installs.
- **Bot access (Phase 5).** The proposal says the bot gets the room ID but not the message key; it will also need the signaling password, and a way past the certificate check.

## Testing still owed

- Reconnect after backgrounding on a real iPhone: lock the phone or switch apps for a minute, come back, and check the chat recovers and catches up without a reload.
- Phase 1 and Phase 2 exit tests on Android.
- History surviving on iOS over several days, in a Safari tab and installed to the Home Screen.
