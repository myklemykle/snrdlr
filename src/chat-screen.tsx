import {useEffect, useMemo, useRef, useState} from 'preact/hooks'
import {claimChat, unclaimChat} from './background'
import {admit, authFor, chatFromGroupInvite, groupFromDirect} from './chats'
import {emojiSize, splitEmoji} from './emoji'
import {EmojiPicker} from './emoji-picker'
import {MAX_TEXT_LENGTH} from './envelope'
import {memberId, type Identity} from './identity'
import {createInvite, inviteToFragment, type Invite} from './invite'
import {hostInvite} from './invite-room'
import {openCert} from './membership'
import {QrCode} from './qr'
import {messageKey, QUICK_REACTIONS, tallyReactions} from './reactions'
import {describeRoutes, type Route} from './route'
import {uniqueChatName} from './names'
import {openSession, type ConnectionStatus, type Session} from './session'
import type {ChatRecord, MessageRecord, Store} from './store'
import {dayKey, formatDay, formatTime} from './time'
import {joinChat} from './transport'
import {fetchTurnServers} from './turn'

const ROUTE_POLL_MS = 3000
// A forgotten invite screen should not stay open indefinitely.
const INVITE_LIFETIME_MS = 10 * 60 * 1000

const BUSY_LABELS: Record<Exclude<ConnectionStatus, 'idle'>, string> = {
  connecting: 'Connecting…',
  searching: 'Looking for others…',
  checking: 'Checking connection…',
  reconnecting: 'Reconnecting…'
}

// How long a finger must rest on a message to open its menu, and how far it may drift meanwhile.
const LONG_PRESS_MS = 450
const LONG_PRESS_SLOP_PX = 10

export function ChatScreen(props: {
  chat: ChatRecord
  identity: Identity
  store: Store
  /** Start with the invite code showing, as when the chat was just created. */
  inviteOnOpen: boolean
  onBack: () => void
  /** Go to another chat, optionally with its invite code showing. */
  onOpenChat: (id: string, showInvite: boolean) => void
}) {
  const {chat, identity, store, inviteOnOpen, onBack, onOpenChat} = props
  const direct = chat.kind === 'dm'
  const [chatName, setChatName] = useState(chat.name)
  const [messages, setMessages] = useState<MessageRecord[] | null>(null)
  const [peers, setPeers] = useState<string[]>([])
  const [routes, setRoutes] = useState<Route[]>([])
  const [status, setStatus] = useState<ConnectionStatus>('connecting')
  const [error, setError] = useState<string | null>(null)
  const [invite, setInvite] = useState<Invite | null>(() => (inviteOnOpen && !direct ? createInvite(identity) : null))
  const [inviteNote, setInviteNote] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)
  const [draft, setDraft] = useState('')
  const session = useRef<Session | null>(null)
  const logEnd = useRef<HTMLDivElement>(null)

  useEffect(() => {
    let cancelled = false
    let opened: Session | null = null
    void (async () => {
      // Take the chat over from any background sync before joining its room ourselves.
      await claimChat(chat.id)
      if (cancelled) return
      opened = await openSession({
        chat,
        identity,
        store,
        // Fetched on every (re)connect, so long-open chats never reuse expired TURN credentials.
        connect: async (keys, handlers) => joinChat(keys, handlers, await fetchTurnServers(), authFor(chat, identity)),
        handlers: {
          onMessages: next => !cancelled && setMessages(next),
          onChatName: next => !cancelled && setChatName(next),
          onStatus: next => !cancelled && setStatus(next),
          onPeersChange: peerIds => {
            if (cancelled) return
            setPeers(peerIds)
            if (peerIds.length > 0) setError(null)
          },
          onError: message => !cancelled && setError(message)
        }
      })
      if (cancelled) void opened.close()
      else session.current = opened
    })().catch(() => !cancelled && setError("This chat couldn't be opened."))
    return () => {
      cancelled = true
      session.current = null
      void Promise.resolve(opened?.close()).finally(() => unclaimChat(chat.id))
    }
  }, [chat.id])

  // Everything on screen counts as read, including what arrives while the chat is open.
  useEffect(() => {
    if (messages) void store.markRead(chat.id, Date.now())
  }, [messages])

  // Shows the chat's name in tabs and browser history.
  useEffect(() => {
    const before = document.title
    document.title = `${chatName} · snrdlr`
    return () => {
      document.title = before
    }
  }, [chatName])

  // Phones drop connections when the app is in the background, so check on them when it comes back.
  useEffect(() => {
    let hiddenAt: number | null = document.hidden ? Date.now() : null
    const onVisibility = () => {
      if (document.hidden) hiddenAt = Date.now()
      else {
        void session.current?.resume(hiddenAt === null ? 0 : Date.now() - hiddenAt)
        hiddenAt = null
      }
    }
    const onPageShow = (event: PageTransitionEvent) => event.persisted && void session.current?.resume(Infinity)
    const onOnline = () => void session.current?.resume(Infinity)
    document.addEventListener('visibilitychange', onVisibility)
    addEventListener('pageshow', onPageShow)
    addEventListener('online', onOnline)
    return () => {
      document.removeEventListener('visibilitychange', onVisibility)
      removeEventListener('pageshow', onPageShow)
      removeEventListener('online', onOnline)
    }
  }, [])

  // While an invite is showing, wait in its room and let in everyone who arrives. Closing it forgets
  // the token, so the code stops working.
  useEffect(() => {
    if (!invite) return
    let cancelled = false
    let host: {close: () => void} | null = null
    void fetchTurnServers().then(turnServers => {
      if (cancelled) return
      host = hostInvite(
        invite,
        request => {
          // Admits whoever asks while the code is showing, and records it in the chat for the others.
          const {sealedGrant, cert} = admit(chat, identity, invite, request, Date.now())
          void session.current?.postCert(cert).catch(() => {})
          return sealedGrant
        },
        turnServers
      )
    })
    const timer = setTimeout(() => {
      setInvite(null)
      setInviteNote('The invite closed after 10 minutes.')
    }, INVITE_LIFETIME_MS)
    return () => {
      cancelled = true
      clearTimeout(timer)
      host?.close()
    }
  }, [invite])

  // Polled, because the route can change mid-connection and browsers fire no event for it.
  useEffect(() => {
    if (peers.length === 0) return setRoutes([])
    let cancelled = false
    const refresh = () => void session.current?.routes().then(found => !cancelled && setRoutes(found))
    refresh()
    const timer = setInterval(refresh, ROUTE_POLL_MS)
    return () => {
      cancelled = true
      clearInterval(timer)
    }
  }, [peers])


  // A member can post their profile more than once; only the first is shown as joining.
  const firstProfiles = useMemo(() => {
    const seen = new Set<string>()
    const first = new Set<MessageRecord>()
    for (const message of messages ?? []) {
      if (message.content.type !== 'profile' || seen.has(message.author)) continue
      seen.add(message.author)
      first.add(message)
    }
    return first
  }, [messages])
  // The messages that get a line of their own. Certificates show through the "joined" lines, reactions
  // on the message they are about, and unknown kinds wait for a newer version of the app.
  const shown = useMemo(
    () =>
      (messages ?? []).filter(message => {
        const {type} = message.content
        if (type === 'profile') return message.author !== identity.id && firstProfiles.has(message)
        return type === 'text' || type === 'group-invite'
      }),
    [messages]
  )
  const reactions = useMemo(() => tallyReactions(messages ?? []), [messages])

  // When the on-screen keyboard opens or changes height the log gets shorter. If the newest message was
  // in view, keep it in view; otherwise the keyboard would push it out of sight.
  const log = useRef<HTMLOListElement>(null)
  const atEnd = useRef(true)
  const noteScroll = () => {
    const element = log.current
    if (element) atEnd.current = element.scrollHeight - element.scrollTop - element.clientHeight < 48
  }
  // A new line in the log scrolls to the end. A reaction changes no line, so it only does so if the end
  // was already in view; reacting to an old message must not jump away from it.
  const lineCount = useRef(-1)
  useEffect(() => {
    if (shown.length !== lineCount.current || atEnd.current) logEnd.current?.scrollIntoView({block: 'end'})
    lineCount.current = shown.length
  }, [messages])
  useEffect(() => {
    const keepEnd = () => atEnd.current && logEnd.current?.scrollIntoView({block: 'end'})
    window.addEventListener('resize', keepEnd)
    window.visualViewport?.addEventListener('resize', keepEnd)
    return () => {
      window.removeEventListener('resize', keepEnd)
      window.visualViewport?.removeEventListener('resize', keepEnd)
    }
  }, [])

  // Each member's most recent profile message gives their display name.
  const names = useMemo(() => {
    const found = new Map<string, string>()
    for (const message of messages ?? []) {
      if (message.content.type === 'profile') found.set(message.author, message.content.name)
    }
    return found
  }, [messages])
  const nameOf = (author: string) => (author === identity.id ? 'you' : (names.get(author) ?? `Member ${author.slice(0, 6)}`))

  // Who admitted whom, from the certificates members have posted. Only genuine ones count.
  const invitedBy = useMemo(() => {
    const found = new Map<string, string>()
    for (const message of messages ?? []) {
      const {content} = message
      const bytes = content.type === 'member-cert' ? content.cert : content.type === 'profile' ? content.chain?.at(-1) : undefined
      if (!bytes) continue
      try {
        const cert = openCert(chat.id, bytes)
        found.set(memberId(cert.subject), memberId(cert.issuer))
      } catch {
        // Not a valid certificate for this chat; ignore it.
      }
    }
    return found
  }, [messages])
  const founderId = chat.kind === 'group' ? memberId(chat.context) : null

  const send = (event: Event) => {
    event.preventDefault()
    const text = draft.trim()
    if (!text || !session.current) return
    setDraft('')
    session.current.sendText(text).catch(() => setError('Message could not be sent.'))
  }

  // The menu on one message: reactions, and copying its text.
  const [menu, setMenu] = useState<string | null>(null)
  // The full emoji picker, open for one message.
  const [picking, setPicking] = useState<MessageRecord | null>(null)
  const menuOpenedAt = useRef(0)
  const openMenu = (key: string) => {
    menuOpenedAt.current = Date.now()
    setPicking(null)
    setMenu(key)
  }
  const closeMenu = () => {
    // The finger that opened the menu by pressing also lifts; that must not count as a tap outside it.
    if (Date.now() - menuOpenedAt.current <= 400) return
    setMenu(null)
    setPicking(null)
  }
  const ownReaction = (message: MessageRecord) =>
    reactions.get(messageKey(message))?.find(tally => tally.by.includes(identity.id))?.emoji ?? null
  // From the menu or the message itself, choosing the emoji we already chose takes it away. From the
  // full picker it is left as it is.
  const react = (message: MessageRecord, emoji: string, toggle = true) => {
    setMenu(null)
    setPicking(null)
    const same = ownReaction(message) === emoji
    if (same && !toggle) return
    session.current?.react({author: message.author, seq: message.seq}, same ? '' : emoji).catch(() => setError('Reaction could not be sent.'))
  }
  const copyText = async (text: string) => {
    setMenu(null)
    try {
      await navigator.clipboard.writeText(text)
    } catch {
      setError("Couldn't copy the message.")
    }
  }

  // On a touch screen, resting a finger on a message opens its menu.
  const press = useRef<{timer: number; x: number; y: number} | null>(null)
  const cancelPress = () => {
    if (press.current) clearTimeout(press.current.timer)
    press.current = null
  }
  const startPress = (event: PointerEvent, key: string) => {
    if (event.pointerType === 'mouse' || menu) return
    cancelPress()
    const timer = window.setTimeout(() => {
      press.current = null
      openMenu(key)
    }, LONG_PRESS_MS)
    press.current = {timer, x: event.clientX, y: event.clientY}
  }
  const movePress = (event: PointerEvent) => {
    const started = press.current
    if (started && Math.hypot(event.clientX - started.x, event.clientY - started.y) > LONG_PRESS_SLOP_PX) cancelPress()
  }
  useEffect(() => cancelPress, [])

  const connected = peers.length > 0
  const routeSummary = describeRoutes(routes)
  const inviteUrl = invite ? location.origin + location.pathname + inviteToFragment(invite) : ''
  const toggleInvite = () => {
    setInviteNote(null)
    setCopied(false)
    // A new token each time, so a code from an earlier showing never works again.
    setInvite(invite ? null : createInvite(identity))
  }

  // "Add someone" in a direct chat: start a group that already includes the other person, tell them
  // through this chat, and go to the group with its invite code up for whoever is being added.
  const addSomeone = async () => {
    if (!session.current) return
    try {
      const taken = (await store.listChats()).map(stored => stored.name)
      const started = groupFromDirect(identity, chat, `Group with ${chatName}`, taken, Date.now())
      await store.saveChat(started.chat)
      await session.current.postGroupInvite(started.invite)
      onOpenChat(started.chat.id, true)
    } catch {
      setError("Couldn't start a group.")
    }
  }

  const openGroupInvite = async (message: MessageRecord) => {
    if (message.content.type !== 'group-invite' || !chat.peer) return
    try {
      const group = chatFromGroupInvite(message.content, chat.peer.signPublic, identity, Date.now())
      const others = (await store.listChats()).filter(stored => stored.id !== group.id).map(stored => stored.name)
      const saved = await store.saveChat({...group, name: uniqueChatName(group.name, others)})
      onOpenChat(saved.id, false)
    } catch {
      setError("That group invite isn't valid.")
    }
  }

  const copyInvite = async () => {
    try {
      await navigator.clipboard.writeText(inviteUrl)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch {
      setError("Couldn't copy the link.")
    }
  }

  return (
    <main class="chat">
      <header>
        <button type="button" class="back" onClick={onBack} aria-label="Back to chats">
          ‹
        </button>
        <div class="title">
          <h1>{chatName}</h1>
          {connected ? (
            <p class="status on">{`Connected to ${peers.length}${routeSummary && ` · ${routeSummary}`}`}</p>
          ) : status === 'idle' ? (
            <p class="status">Nobody else is here right now</p>
          ) : (
            <p class="status busy">{BUSY_LABELS[status]}</p>
          )}
        </div>
        {direct ? (
          <button type="button" onClick={addSomeone} disabled={!messages}>
            Add someone
          </button>
        ) : (
          <button type="button" onClick={toggleInvite}>
            {invite ? 'Stop inviting' : 'Invite'}
          </button>
        )}
      </header>

      {error && <p class="error">{error}</p>}

      {inviteNote && <p class="note">{inviteNote}</p>}

      {invite && (
        <section class="invite">
          <QrCode text={inviteUrl} label="Invite code for this chat" />
          <p>Anyone who scans this while it is on your screen can join. It stops working when you close it.</p>
          <button type="button" onClick={copyInvite}>
            {copied ? 'Copied' : 'Copy invite link'}
          </button>
        </section>
      )}

      <ol class="log" ref={log} onScroll={noteScroll}>
        {shown.map((message, index, all) => {
          const mine = message.author === identity.id
          const key = messageKey(message)
          const day = dayKey(message.sentAt)
          const newDay = day !== '' && (index === 0 || day !== dayKey(all[index - 1].sentAt))
          const separator = newDay && (
            <li key={`day:${key}`} class="event day">
              {formatDay(message.sentAt)}
            </li>
          )
          if (message.content.type === 'profile') {
            const inviter = invitedBy.get(message.author)
            return [
              separator,
              <li key={key} class="event">
                {message.author === founderId
                  ? `${message.content.name} started this chat`
                  : `${message.content.name} joined${inviter ? ` · invited by ${nameOf(inviter)}` : ''}`}
              </li>
            ]
          }
          if (message.content.type === 'group-invite') {
            return [
              separator,
              <li key={key} class="event">
                {mine ? (
                  `You started the group "${message.content.name}" with ${chatName}`
                ) : (
                  <>
                    {nameOf(message.author)} added you to the group "{message.content.name}"{' '}
                    <button type="button" class="inline" onClick={() => openGroupInvite(message)}>
                      Open
                    </button>
                  </>
                )}
              </li>
            ]
          }
          if (message.content.type !== 'text') return separator
          const {text} = message.content
          const size = emojiSize(text)
          const tallies = reactions.get(key)
          const own = ownReaction(message)
          const open = menu === key
          return [
            separator,
            <li
              key={key}
              class={`${mine ? 'mine' : 'theirs'}${size ? ` ${size}` : ''}${tallies ? ' reacted' : ''}${open ? ' menu-open' : ''}`}
              onPointerDown={event => startPress(event, key)}
              onPointerMove={movePress}
              onPointerUp={cancelPress}
              onPointerCancel={cancelPress}
              onPointerLeave={cancelPress}
              // A long press must open our menu, not the browser's.
              onContextMenu={event => (press.current || open) && event.preventDefault()}
            >
              {!mine && <span class="author">{nameOf(message.author)}</span>}
              {splitEmoji(text).map(segment => (segment.emoji ? <span class="emoji">{segment.text}</span> : segment.text))}
              <time class="time" dateTime={new Date(message.sentAt).toISOString()}>
                {formatTime(message.sentAt)}
              </time>
              {tallies && (
                <span class="reactions">
                  {tallies.map(tally => {
                    const who = tally.by.map(nameOf).join(', ')
                    return (
                      <button
                        key={tally.emoji}
                        type="button"
                        class={tally.by.includes(identity.id) ? 'own' : ''}
                        aria-label={`${tally.emoji} from ${who}`}
                        title={who}
                        onClick={() => react(message, tally.emoji)}
                      >
                        {tally.emoji}
                        {tally.by.length > 1 && <span class="count">{tally.by.length}</span>}
                      </button>
                    )
                  })}
                </span>
              )}
              <button type="button" class="react" aria-label="React or copy" aria-expanded={open} onClick={() => (open ? setMenu(null) : openMenu(key))}>
                ☺
              </button>
              {open && (
                <div class="menu" ref={element => element?.scrollIntoView({block: 'nearest'})}>
                  <div class="quick">
                    {QUICK_REACTIONS.map(emoji => (
                      <button key={emoji} type="button" class={own === emoji ? 'own' : ''} aria-label={`React ${emoji}`} onClick={() => react(message, emoji)}>
                        {emoji}
                      </button>
                    ))}
                    <button
                      type="button"
                      aria-label="Another emoji"
                      onClick={() => {
                        setMenu(null)
                        setPicking(message)
                      }}
                    >
                      ＋
                    </button>
                  </div>
                  {tallies && <p class="who">{tallies.map(tally => `${tally.emoji} ${tally.by.map(nameOf).join(', ')}`).join(' · ')}</p>}
                  <button type="button" class="copy" onClick={() => copyText(text)}>
                    Copy text
                  </button>
                </div>
              )}
            </li>
          ]
        })}
        <div ref={logEnd} />
      </ol>

      {(menu || picking) && <div class="menu-backdrop" onClick={closeMenu} />}
      {picking && <EmojiPicker onPick={emoji => react(picking, emoji, false)} onClose={() => setPicking(null)} />}

      <form class="composer" onSubmit={send}>
        <input
          value={draft}
          onInput={event => setDraft(event.currentTarget.value)}
          placeholder={connected ? 'Message' : 'Message (delivered when you are both here)'}
          maxLength={MAX_TEXT_LENGTH}
          aria-label="Message"
          autocomplete="off"
        />
        <button type="submit" disabled={!messages || !draft.trim()}>
          Send
        </button>
      </form>
    </main>
  )
}
