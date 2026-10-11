import {useEffect, useMemo, useRef, useState} from 'preact/hooks'
import {MAX_TEXT_LENGTH} from './envelope'
import type {Identity} from './identity'
import {inviteToFragment} from './invite'
import {QrCode} from './qr'
import {describeRoutes, type Route} from './route'
import {openSession, type Session} from './session'
import type {ChatRecord, MessageRecord, Store} from './store'
import {joinChat} from './transport'
import {fetchTurnServers} from './turn'

const ROUTE_POLL_MS = 3000

const messageKey = (message: MessageRecord) => `${message.author}:${message.seq}`

export function ChatScreen(props: {chat: ChatRecord; identity: Identity; store: Store; onBack: () => void}) {
  const {chat, identity, store, onBack} = props
  const [messages, setMessages] = useState<MessageRecord[] | null>(null)
  const [peers, setPeers] = useState<string[]>([])
  const [routes, setRoutes] = useState<Route[]>([])
  const [error, setError] = useState<string | null>(null)
  const [showQr, setShowQr] = useState<boolean | null>(null)
  const [copied, setCopied] = useState(false)
  const [draft, setDraft] = useState('')
  const session = useRef<Session | null>(null)
  const logEnd = useRef<HTMLDivElement>(null)

  useEffect(() => {
    let cancelled = false
    let opened: Session | null = null
    void (async () => {
      const turnServers = await fetchTurnServers()
      if (cancelled) return
      opened = await openSession({
        chat,
        identity,
        store,
        connect: (keys, handlers) => joinChat(keys, handlers, turnServers),
        handlers: {
          onMessages: next => !cancelled && setMessages(next),
          onPeersChange: peerIds => {
            if (cancelled) return
            setPeers(peerIds)
            if (peerIds.length > 0) {
              setShowQr(false)
              setError(null)
            }
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

  // Offer the code up front only while nobody else has ever been in the chat.
  useEffect(() => {
    if (showQr === null && messages) setShowQr(messages.every(message => message.author === identity.id))
  }, [messages])

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
  const inviteUrl = location.origin + location.pathname + inviteToFragment({secret: chat.secret, name: chat.name})

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
        <button type="button" onClick={() => setShowQr(!showQr)}>
          {showQr ? 'Hide code' : 'Show code'}
        </button>
      </header>

      {error && <p class="error">{error}</p>}

      {showQr && (
        <section class="invite">
          <QrCode text={inviteUrl} label="Invite code for this chat" />
          <p>Scan with a phone camera to join. Anyone who sees this code can join and read the chat.</p>
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
          placeholder={connected ? 'Message' : 'You can send once someone is here'}
          maxLength={MAX_TEXT_LENGTH}
          aria-label="Message"
          autocomplete="off"
        />
        <button type="submit" disabled={!connected || !draft.trim()}>
          Send
        </button>
      </form>
    </main>
  )
}
