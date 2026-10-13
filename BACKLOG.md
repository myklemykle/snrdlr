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

### How reply would work

A reply is an ordinary message whose encrypted payload also names the message it answers, by author and sequence number. The app shows a quoted snippet above the reply and jumps to the original on tap. If the original is not on this device (not synced yet, or sent before you joined), it shows "original message not available". Because the reference is inside the signed payload, nobody can re-point a reply at a different message.

This changes the message format, so it needs a rule for how older app versions treat message types they do not know.

## Images and audio messages

Wanted after Phase 4. The proposal doc lists file transfer as a non-goal for v1, so this extends the plan. No foundation work is needed first, provided media stays out of the message log:

- A media message is a small signed message holding a reference: the file's hash, size, type, its own encryption key and a tiny thumbnail. The file is fetched separately, on demand, from any member who has it.
- Files get their own table in storage, and their own fetch-by-hash request next to sync.
- Older app versions keep message types they do not recognise, so they will not lose these messages.

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

- **A relay holding a non-member's messages keeps offering them.** Phones refuse a message whose author has no certificate, but do not tell the sender, so it is offered again on every sync round. Only a blind bot could hold such messages. Costs bandwidth only.
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
- **Final address.** The app is at `alpha.snrdlr.net` while it is in testing, and nobody is promised their chats will last. Keys and history are tied to the address, so pick the permanent one (for example `snrdlr.net` itself) before anyone is; moving strands every install unless identities can be exported and imported.
- **Bot access (Phase 5).** The proposal says the bot gets the room ID but not the message key; it will also need the signaling password, and a way past the connection check. It cannot check authors itself, since it cannot read certificates; members do that when they receive what it stored.
- **Stay connected on desktop.** A mode for desktop browsers that keeps every chat connected while the tab is open, so one awake computer passes messages between members who are never online together. Any member already relays for the chat on screen; this extends it to all of them. Comes before the blind bot. Check how browsers throttle or discard a background tab (Chrome's Memory Saver, timers while no peer is connected), and ask for persistent storage.

## Testing still owed

- Reconnect after backgrounding on a real iPhone: lock the phone or switch apps for a minute, come back, and check the chat recovers and catches up without a reload.
- Phase 1 and Phase 2 exit tests on Android.
- History surviving on iOS over several days, in a Safari tab and installed to the Home Screen.
