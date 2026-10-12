import {useEffect, useMemo, useRef, useState} from 'preact/hooks'
import {MAX_TEXT_LENGTH} from './envelope'
import type {Identity} from './identity'
import {createInvite, inviteToFragment, sealGrant, type Invite} from './invite'
import {hostInvite} from './invite-room'
import {QrCode} from './qr'
import {describeRoutes, type Route} from './route'
import {openSession, type Session} from './session'
import type {ChatRecord, MessageRecord, Store} from './store'
import {joinChat} from './transport'
import {fetchTurnServers} from './turn'

const ROUTE_POLL_MS = 3000
// A forgotten invite screen should not stay open indefinitely.
const INVITE_LIFETIME_MS = 10 * 60 * 1000

const messageKey = (message: MessageRecord) => `${message.author}:${message.seq}`

export function ChatScreen(props: {
  chat: ChatRecord
  identity: Identity
  store: Store
  /** Start with the invite code showing, as when the chat was just created. */
  inviteOnOpen: boolean
  onBack: () => void
}) {
  const {chat, identity, store, inviteOnOpen, onBack} = props
  const [messages, setMessages] = useState<MessageRecord[] | null>(null)
  const [peers, setPeers] = useState<string[]>([])
  const [routes, setRoutes] = useState<Route[]>([])
  const [error, setError] = useState<string | null>(null)
  const [invite, setInvite] = useState<Invite | null>(() => (inviteOnOpen ? createInvite(identity) : null))
  const [inviteNote, setInviteNote] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)
  const [draft, setDraft] = useState('')
  const session = useRef<Session | null>(null)
  const logEnd = useRef<HTMLDivElement>(null)

  useEffect(() => {
    let cancelled = false
    let opened: Session | null = null
    void (async () => {
      opened = await openSession({
        chat,
        identity,
        store,
        // Fetched on every (re)connect, so long-open chats never reuse expired TURN credentials.
        connect: async (keys, handlers) => joinChat(keys, handlers, await fetchTurnServers()),
        handlers: {
          onMessages: next => !cancelled && setMessages(next),
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
      void opened?.close()
    }
  }, [chat.id])

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
      host = hostInvite(invite, sealGrant(identity, invite, {secret: chat.secret, name: chat.name}), turnServers)
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

  useEffect(() => logEnd.current?.scrollIntoView({block: 'end'}), [messages])

  // Each member's most recent profile message gives their display name.
  const names = useMemo(() => {
    const found = new Map<string, string>()
    for (const message of messages ?? []) {
      if (message.content.type === 'profile') found.set(message.author, message.content.name)
    }
    return found
  }, [messages])
  const nameOf = (author: string) => names.get(author) ?? `Member ${author.slice(0, 6)}`

  const send = (event: Event) => {
    event.preventDefault()
    const text = draft.trim()
    if (!text || !session.current) return
    setDraft('')
    session.current.sendText(text).catch(() => setError('Message could not be sent.'))
  }

  const connected = peers.length > 0
  const routeSummary = describeRoutes(routes)
  const inviteUrl = invite ? location.origin + location.pathname + inviteToFragment(invite) : ''
  const toggleInvite = () => {
    setInviteNote(null)
    setCopied(false)
    // A new token each time, so a code from an earlier showing never works again.
    setInvite(invite ? null : createInvite(identity))
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
          <h1>{chat.name}</h1>
          <p class={connected ? 'status on' : 'status'}>
            {connected ? `Connected to ${peers.length}${routeSummary && ` · ${routeSummary}`}` : 'Nobody else is here right now'}
          </p>
        </div>
        <button type="button" onClick={toggleInvite}>
          {invite ? 'Stop inviting' : 'Invite'}
        </button>
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

      <ol class="log">
        {(messages ?? []).map(message => {
          const mine = message.author === identity.id
          if (message.content.type === 'profile') {
            return mine ? null : (
              <li key={messageKey(message)} class="event">
                {message.content.name} joined
              </li>
            )
          }
          return (
            <li key={messageKey(message)} class={mine ? 'mine' : 'theirs'}>
              {!mine && <span class="author">{nameOf(message.author)}</span>}
              {message.content.text}
            </li>
          )
        })}
        <div ref={logEnd} />
      </ol>

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
