import {useEffect, useRef, useState} from 'preact/hooks'
import {inviteFromFragment, inviteToFragment, type Invite} from './invite'
import {deriveChatKeys, generateGroupSecret} from './keys'
import {QrCode} from './qr'
import {joinChat, type Chat} from './transport'
import {fetchTurnServers} from './turn'

type Message = {id: number; mine: boolean; text: string}

function useInvite(): Invite | null {
  const [invite, setInvite] = useState(() => inviteFromFragment(location.hash))
  useEffect(() => {
    const onHashChange = () => setInvite(inviteFromFragment(location.hash))
    addEventListener('hashchange', onHashChange)
    return () => removeEventListener('hashchange', onHashChange)
  }, [])
  return invite
}

export function App() {
  const invite = useInvite()
  // Keyed by the fragment so a different invite gets a fresh chat.
  return invite ? <ChatScreen key={location.hash} invite={invite} /> : <HomeScreen />
}

function HomeScreen() {
  const [name, setName] = useState('')
  const start = (event: Event) => {
    event.preventDefault()
    // Phase 1 keeps nothing on the device; the fragment is the only copy of the secret.
    location.hash = inviteToFragment({secret: generateGroupSecret(), name: name.trim() || 'Chat'})
  }
  return (
    <main class="home">
      <h1>snrdlr</h1>
      <p>Start a chat, then let someone scan your code to join it.</p>
      <form onSubmit={start}>
        <input
          value={name}
          onInput={event => setName(event.currentTarget.value)}
          placeholder="Chat name (optional)"
          maxLength={64}
          aria-label="Chat name"
        />
        <button type="submit">Start a chat</button>
      </form>
    </main>
  )
}

function ChatScreen({invite}: {invite: Invite}) {
  const [messages, setMessages] = useState<Message[]>([])
  const [peers, setPeers] = useState<string[]>([])
  const [error, setError] = useState<string | null>(null)
  const [showQr, setShowQr] = useState(true)
  const [draft, setDraft] = useState('')
  const chat = useRef<Chat | null>(null)
  const nextId = useRef(0)
  const logEnd = useRef<HTMLDivElement>(null)

  const append = (mine: boolean, text: string) =>
    setMessages(previous => [...previous, {id: nextId.current++, mine, text}])

  useEffect(() => {
    let cancelled = false
    let joined: Chat | null = null
    void fetchTurnServers().then(turnServers => {
      if (cancelled) return
      joined = joinChat(
        deriveChatKeys(invite.secret),
        {
          onText: text => append(false, text),
          onPeersChange: peerIds => {
            setPeers(peerIds)
            if (peerIds.length > 0) {
              setShowQr(false)
              setError(null)
            }
          },
          onError: setError
        },
        turnServers
      )
      chat.current = joined
    })
    return () => {
      cancelled = true
      chat.current = null
      void joined?.leave()
    }
  }, [invite])

  useEffect(() => logEnd.current?.scrollIntoView({block: 'end'}), [messages])

  const send = (event: Event) => {
    event.preventDefault()
    const text = draft.trim()
    if (!text || !chat.current) return
    append(true, text)
    setDraft('')
    chat.current.send(text).catch(() => setError('Message could not be sent.'))
  }

  const connected = peers.length > 0
  const inviteUrl = location.origin + location.pathname + inviteToFragment(invite)

  return (
    <main class="chat">
      <header>
        <div>
          <h1>{invite.name}</h1>
          <p class={connected ? 'status on' : 'status'}>
            {connected ? `Connected to ${peers.length}` : 'Waiting for someone to join…'}
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
          <p>Scan with a phone camera to join. Anyone who sees this code can join.</p>
        </section>
      )}

      <ol class="log">
        {messages.map(message => (
          <li key={message.id} class={message.mine ? 'mine' : 'theirs'}>
            {message.text}
          </li>
        ))}
        <div ref={logEnd} />
      </ol>

      <form class="composer" onSubmit={send}>
        <input
          value={draft}
          onInput={event => setDraft(event.currentTarget.value)}
          placeholder={connected ? 'Message' : 'Nobody is here yet'}
          maxLength={4000}
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
