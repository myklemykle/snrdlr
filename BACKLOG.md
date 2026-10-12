# Open items

Things noted along the way that are not part of the current phase. The phased plan itself lives in the proposal doc.

## Features requested

- **Sounds** when sending or receiving a message.
  - Browsers only allow audio after a tap, so the first sound needs unlocking on a user gesture.
  - Only works while the app is open; notifications when closed are Phase 6 (push).
- **Names and nicknames.**
  - A real name for each user, and a chat name set by whoever creates the chat. Both exist today; neither can be changed after creation.
  - Rename a chat in progress. Needs a new message type (`rename` in the proposal) so every member sees the new name, and a rule for who may rename.
  - Unique chat names. The default name "Chat" gets duplicated in the chat list; pick a distinct default (for example "Chat 2", or one based on the date or members) and warn on a duplicate.
  - Local nicknames for users and chats, set on your own device and never sent to anyone.
- **Leave a chat.** A "leave" button on each entry in the chat list that forgets the chat: its secret and its history on this device. Other members keep their copies, and until Phase 4 they are not told you left.
- **Larger emoji** in chat messages, especially messages that are only emoji.
- **Message context menu** (hover on desktop, press and hold on touch):
  - Reply. See "How reply would work" below.
  - DM this user. The proposal's default is in-person pairing only for v1; starting a DM from inside a group needs each member's X25519 public key, which profile messages do not carry yet.
  - User info.
- **Inviter approval.** Optionally have the inviter confirm each joiner by name. Left out on purpose for now: while a code is showing, everyone who scans it gets in, and it is the inviter's job not to be photographed.
- **User profile.** Optional fields beyond the name, kept on the device, with a per-chat choice of whether to share it when joining a new chat. Profiles are already posted per chat, so the choice fits the current design.

### How reply would work

A reply is an ordinary message whose encrypted payload also names the message it answers, by author and sequence number. The app shows a quoted snippet above the reply and jumps to the original on tap. If the original is not on this device (not synced yet, or sent before you joined), it shows "original message not available". Because the reference is inside the signed payload, nobody can re-point a reply at a different message.

This changes the message format, so it needs a rule for how older app versions treat message types they do not know.

## Engineering follow-ups

- **Trystero does not fully leave a room left within about a second of joining.** The room keeps answering newcomers. The app works around it (closed invites refuse requests; leaving is delayed until the join settles). Worth reproducing in isolation and reporting upstream.
- **Pin a vetted list of Nostr relays.** The app uses Trystero's default list; one public relay rate-limited us during testing.
- **Automatic TURN cut-off.** A scheduled check that deletes the TURN key if usage passes a threshold, as a backstop against a large bill. Wanted before sharing the app widely.
- **Two tabs of one chat on the same device.** Each tab only shows the other's messages after a reload.
- **Unknown message types.** Today an unrecognised type is dropped. Decide whether to store it for later display once the app is updated.
- **Run the browser test in CI.** It is hermetic now (local relay), so it could gate deploys.
- **Custom domain.** Keys and history are tied to `myklemykle.github.io`; moving later strands existing installs.
- **Bot access (Phase 5).** The proposal says the bot gets the room ID but not the message key; it will also need the signaling password, and a way past the certificate check.

## Testing still owed

- Phase 1 and Phase 2 exit tests on Android.
- History surviving on iOS over several days, in a Safari tab and installed to the Home Screen.
