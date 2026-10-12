# Android test plan

A run-through for the first Android phone. About 45 minutes with a second device in hand.

App: https://myklemykle.github.io/snrdlr/

## Before you start

You need:

- The Android phone, with Wi-Fi and mobile data both available.
- A second device that is known to work: the iPhone SE, or Chrome on the Mac. Reload the app on it first so both run the same version.
- For section 8 only, a third device.

Write down, once:

- Phone model and Android version (Settings → About phone).
- Browser and version (Chrome → menu → Settings → About Chrome). If the phone is a Samsung, note whether links open in Chrome or Samsung Internet; they are different browsers with separate storage. Run the plan in Chrome first.

For anything that fails, note the step number, what the screen said (the status line under the chat name is the most useful part), and whether a reload fixed it. A screenshot is enough.

"Android" below means the phone under test; "other" means the known-good device.

## 1. First launch

- [ ] 1.1 Open the app address in Chrome. It asks "What should people call you?". No storage warning appears.
- [ ] 1.2 Enter a name. The home screen shows "Start a group" and "Chat with one person".
- [ ] 1.3 Close the tab, open the address again. It goes straight to the home screen without asking the name.

## 2. Android invites, other joins

- [ ] 2.1 On Android, tap "Start a group", give it a name. The chat opens with a QR code showing.
- [ ] 2.2 The code is fully visible without scrolling and is sharp, not blurred.
- [ ] 2.3 Scan it with the other device. The other device joins within a few seconds.
- [ ] 2.4 The status line on both shows a route: "local network", "direct" or "relayed". Note which.
- [ ] 2.5 Send a message each way. Both arrive, with the right name and time.
- [ ] 2.6 On Android the chat shows "<your name> started this chat" and "<other> joined · invited by <your name>".

## 3. Other invites, Android joins

This is the camera test, the part most likely to differ between phones.

- [ ] 3.1 On the other device, start a new group so its code is showing.
- [ ] 3.2 On Android, open the phone's **camera app** and point it at the code. Note what it offers: a link to tap, a Google Lens button, or nothing.
- [ ] 3.3 Tap it. Note where it opens: a Chrome tab, or a browser view inside the camera or Google app (no address bar, or an "Open in Chrome" menu item).
- [ ] 3.4 It shows "Joining the chat…" and then the chat, as the same person as in section 1. It must not ask for a name again. If it does, the link opened in a different browser from the one used in section 1; note which.
- [ ] 3.5 Send a message each way.
- [ ] 3.6 If the camera app offers nothing in 3.2, try Chrome's own scanner (tap the address bar, then the camera or Lens icon) and note whether that works.
- [ ] 3.7 Stale code: on the other device, tap "Copy invite link" while its code is showing and send the link to the Android phone (email or any messenger). Tap "Stop inviting" on the other device, then open the link on Android. Within about 30 seconds it should say "That invite is no longer active. Ask the person inviting you to show a fresh code."

## 4. Typing and the screen

- [ ] 4.1 Tap the message box. The keyboard opens and the box stays visible above it, not hidden behind it.
- [ ] 4.2 With the keyboard open, the newest message is still visible.
- [ ] 4.3 Send with the keyboard's send or enter key, and with the on-screen send button. Note what the enter key does.
- [ ] 4.4 Send one emoji alone, three emoji alone, and emoji mixed with text. One alone is largest, a few alone are large, mixed are slightly larger than the text. None are cut off or shown as empty boxes.
- [ ] 4.5 Send a long message that wraps over several lines, and a very long word or link. Nothing runs off the side of the screen.
- [ ] 4.6 Rotate the phone to landscape and back. The layout survives.
- [ ] 4.7 Fill the chat past one screen. It scrolls smoothly, and a new incoming message scrolls into view.
- [ ] 4.8 Android's back gesture or button from a chat. Note what happens: back to the chat list, or out of the app.
- [ ] 4.9 The tab's title reads "<chat name> · snrdlr".

## 5. Leaving and coming back

- [ ] 5.1 With both in a chat, press Android's home button, wait 10 seconds, return. The chat is still connected or reconnects by itself.
- [ ] 5.2 While Android is on the home screen for **one minute**, send two messages from the other device. Return to Chrome. The status passes through "Checking connection…" or "Reconnecting…" and both messages appear without a reload.
- [ ] 5.3 Lock the phone for **two minutes** while the other device sends two messages. Unlock. Same result.
- [ ] 5.4 Repeat 5.3 for **ten minutes**. Android may have discarded the tab; note whether the page reloads by itself, and whether the messages arrive either way.
- [ ] 5.5 Send from Android while the other device is closed. The message appears in the chat on Android. Reopen the other device; the message arrives there.
- [ ] 5.6 Reload the page on Android. The chat and its full history are still there.

## 6. Networks

- [ ] 6.1 Both on the same Wi-Fi: the route reads "local network".
- [ ] 6.2 Turn Wi-Fi off on Android so it uses mobile data. Within about 20 seconds it reconnects by itself. Note the route ("direct" or "relayed") and the carrier.
- [ ] 6.3 Send a message each way on mobile data.
- [ ] 6.4 Turn Wi-Fi back on. It recovers again without a reload, and no red error stays on screen.
- [ ] 6.5 Turn on airplane mode for 30 seconds, type and send a message, turn it off. The message goes out once the connection returns.

## 7. Chat list

- [ ] 7.1 Go back to the chat list. Both chats are listed with their names.
- [ ] 7.2 Leave the app, have the other device send three messages to one chat and stay open, wait a minute, return to the list. That chat shows an unread count of 3.
- [ ] 7.3 Open the chat; go back to the list. The count is gone.
- [ ] 7.4 Tap "Leave" on a chat, read the confirmation, confirm. The chat disappears and stays gone after a reload.

## 8. Direct chats and adding someone

- [ ] 8.1 On Android, under "Chat with one person", tap "Show my code". Scan it with the other device. A chat opens on both, named after the other person and tagged "direct" in the list.
- [ ] 8.2 The direct chat has no "Invite" button.
- [ ] 8.3 Tap "Hide my code". Now the other device shows its code and Android scans it. It reopens the same chat rather than making a second one.
- [ ] 8.4 Send a message each way in the direct chat.
- [ ] 8.5 In the direct chat on Android, tap "Add someone". A new group opens with its code showing. On the other device, a line with an "Open" button appears in the direct chat; tapping it joins the group.
- [ ] 8.6 With a third device, scan the group's code. All three can read each other's messages, and the third shows "joined · invited by <Android's name>".

## 9. The next day

- [ ] 9.1 Close Chrome completely (swipe it away from recent apps). Open it again the next day. The name, the chat list and all history are still there.
- [ ] 9.2 Messages sent to Android overnight arrive once both devices are open together.

## If there is time

- [ ] Repeat sections 1 to 3 in Samsung Internet or Firefox, whichever the phone has.
- [ ] Open the app in an incognito tab. It should show the "This browser won't let the app store anything" message, or work until the tab is closed.
- [ ] Two Android phones with each other, if a second one turns up.

## What to send back

- The device and browser details from "Before you start".
- The step numbers that failed, with a screenshot each.
- The routes seen in 2.4, 6.1 and 6.2.
- What the camera app did in 3.2 and 3.3, and what the back gesture did in 4.8.
- Anything that felt wrong for an Android user even though it worked: buttons where you did not expect them, gestures that were missing.

To capture error details for a failure: connect the phone to the Mac by USB with USB debugging turned on, open `chrome://inspect` in Chrome on the Mac, and choose "inspect" next to the snrdlr tab. The Console tab shows the phone's errors.
