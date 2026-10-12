import {useEffect, useState} from 'preact/hooks'
import {ChatScreen} from './chat-screen'
import {cleanName, createIdentity, loadIdentity, MAX_NAME_LENGTH, type Identity} from './identity'
import {inviteFromFragment, isInviteFragment} from './invite'
import {redeemInvite} from './invite-room'
import {deriveChatKeys, generateGroupSecret} from './keys'
import {openStore, type ChatRecord, type Store} from './store'
import {fetchTurnServers} from './turn'

const CHAT_PREFIX = '#c='
const JOIN_TIMEOUT_MS = Number(import.meta.env.VITE_JOIN_TIMEOUT_MS) || 30_000
const STALE_INVITE = 'That invite is no longer active. Ask the person inviting you to show a fresh code.'

type Boot = {status: 'loading'} | {status: 'failed'} | {status: 'ready'; store: Store; identity: Identity | null}

/** Progress of redeeming the invite in the address bar, if there is one. */
type Join = {status: 'idle'} | {status: 'joining'} | {status: 'failed'} | {status: 'joined'; chatId: string}

export function App() {
  const [boot, setBoot] = useState<Boot>({status: 'loading'})

  useEffect(() => {
    openStore()
      .then(async store => {
        const secrets = await store.getIdentity()
        setBoot({status: 'ready', store, identity: secrets ? loadIdentity(secrets) : null})
      })
      .catch(() => setBoot({status: 'failed'}))
  }, [])

  if (boot.status === 'loading') return null
  if (boot.status === 'failed') {
    return (
      <main class="home">
        <h1>snrdlr</h1>
        <p class="error">This browser won't let the app store anything, so it can't keep your chats. Private browsing often causes this.</p>
      </main>
    )
  }
  const {store} = boot
  return <Main store={store} identity={boot.identity} onIdentity={identity => setBoot({status: 'ready', store, identity})} />
}

/**
 * Redeems an invite as soon as it appears in the address bar, without waiting for the person to
 * finish setting up, because the code only works while the inviter is still showing it.
 */
function useJoin(store: Store, hash: string): [Join, () => void] {
  const [join, setJoin] = useState<Join>({status: 'idle'})

  useEffect(() => {
    if (!isInviteFragment(hash)) return
    const invite = inviteFromFragment(hash)
    if (!invite) return setJoin({status: 'failed'})

    let cancelled = false
    setJoin({status: 'joining'})
    void (async () => {
      try {
        const grant = await redeemInvite(invite, await fetchTurnServers(), JOIN_TIMEOUT_MS)
        const chat = await store.saveChat({
          id: deriveChatKeys(grant.secret).roomId,
          secret: grant.secret,
          name: grant.name,
          createdAt: Date.now()
        })
        if (!cancelled) setJoin({status: 'joined', chatId: chat.id})
      } catch {
        if (!cancelled) setJoin({status: 'failed'})
      }
    })()
    return () => {
      cancelled = true
    }
  }, [hash])

  return [join, () => setJoin({status: 'idle'})]
}

function Main(props: {store: Store; identity: Identity | null; onIdentity: (identity: Identity) => void}) {
  const {store, identity, onIdentity} = props
  const [hash, setHash] = useState(location.hash)
  const [join, clearJoin] = useJoin(store, hash)
  const [chat, setChat] = useState<ChatRecord | null>(null)
  const [inviteOnOpen, setInviteOnOpen] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)

  useEffect(() => {
    const onHashChange = () => setHash(location.hash)
    addEventListener('hashchange', onHashChange)
    return () => removeEventListener('hashchange', onHashChange)
  }, [])

  const openChat = (id: string, replace = false) => {
    if (replace) history.replaceState(null, '', CHAT_PREFIX + id)
    else history.pushState(null, '', CHAT_PREFIX + id)
    setHash(CHAT_PREFIX + id)
  }
  const goHome = (replace = false) => {
    const url = location.pathname + location.search
    if (replace) history.replaceState(null, '', url)
    else history.pushState(null, '', url)
    setHash('')
  }

  // Once the invite has been dealt with, take it out of the address bar and history.
  useEffect(() => {
    if (!identity) return
    if (join.status === 'joined') {
      clearJoin()
      openChat(join.chatId, true)
    } else if (join.status === 'failed') {
      clearJoin()
      setNotice(STALE_INVITE)
      goHome(true)
    }
  }, [join, identity])

  useEffect(() => {
    if (!hash.startsWith(CHAT_PREFIX)) return setChat(null)
    let cancelled = false
    void store.getChat(hash.slice(CHAT_PREFIX.length)).then(found => {
      if (cancelled) return
      if (found) setChat(found)
      else goHome(true)
    })
    return () => {
      cancelled = true
    }
  }, [hash])

  if (!identity) return <Welcome store={store} invited={join.status !== 'idle'} onCreate={onIdentity} />
  if (join.status !== 'idle' || isInviteFragment(hash)) {
    return (
      <main class="home">
        <h1>snrdlr</h1>
        <p>Joining the chat…</p>
        <p class="note">This only works while the person inviting you still has their code on screen.</p>
      </main>
    )
  }
  if (hash.startsWith(CHAT_PREFIX)) {
    const current = chat?.id === hash.slice(CHAT_PREFIX.length) ? chat : null
    return (
      current && (
        <ChatScreen
          key={current.id}
          chat={current}
          identity={identity}
          store={store}
          inviteOnOpen={inviteOnOpen === current.id}
          onBack={() => goHome()}
        />
      )
    )
  }
  return (
    <Home
      store={store}
      identity={identity}
      notice={notice}
      onOpen={id => {
        setNotice(null)
        setInviteOnOpen(null)
        openChat(id)
      }}
      onCreate={id => {
        setNotice(null)
        setInviteOnOpen(id)
        openChat(id)
      }}
    />
  )
}

function Welcome({store, invited, onCreate}: {store: Store; invited: boolean; onCreate: (identity: Identity) => void}) {
  const [name, setName] = useState('')
  const create = async (event: Event) => {
    event.preventDefault()
    const identity = createIdentity(name)
    await store.saveIdentity({name: identity.name, signSecret: identity.signSecret, dhSecret: identity.dhSecret})
    // Asks the browser not to evict our data under storage pressure; it may say no.
    void navigator.storage?.persist?.()
    onCreate(identity)
  }
  return (
    <main class="home">
      <h1>snrdlr</h1>
      <p>{invited ? 'You have been invited to a chat. What should people call you?' : 'What should people call you?'}</p>
      <form onSubmit={create}>
        <input
          value={name}
          onInput={event => setName(event.currentTarget.value)}
          placeholder="Your name"
          maxLength={MAX_NAME_LENGTH}
          aria-label="Your name"
          autocomplete="off"
        />
        <button type="submit" disabled={!cleanName(name)}>
          Continue
        </button>
      </form>
      <p class="note">Your name and keys stay on this device. There is no account, so they can't be recovered if you clear this site's data.</p>
    </main>
  )
}

function Home(props: {
  store: Store
  identity: Identity
  notice: string | null
  onOpen: (id: string) => void
  onCreate: (id: string) => void
}) {
  const {store, identity, notice, onOpen, onCreate} = props
  const [chats, setChats] = useState<ChatRecord[] | null>(null)
  const [name, setName] = useState('')

  useEffect(() => void store.listChats().then(setChats), [])

  const start = async (event: Event) => {
    event.preventDefault()
    const secret = generateGroupSecret()
    const chat = await store.saveChat({
      id: deriveChatKeys(secret).roomId,
      secret,
      name: cleanName(name) || 'Chat',
      createdAt: Date.now()
    })
    onCreate(chat.id)
  }

  return (
    <main class="home">
      <h1>snrdlr</h1>
      <p>Hello, {identity.name}.</p>
      {notice && <p class="error">{notice}</p>}

      {chats && chats.length > 0 && <h2>Your chats</h2>}
      {chats && chats.length > 0 && (
        <ul class="chats" aria-label="Your chats">
          {chats.map(chat => (
            <li key={chat.id}>
              <button type="button" onClick={() => onOpen(chat.id)}>
                {chat.name}
              </button>
            </li>
          ))}
        </ul>
      )}

      <h2>New chat</h2>
      <form onSubmit={start}>
        <input
          value={name}
          onInput={event => setName(event.currentTarget.value)}
          placeholder="Name (optional)"
          maxLength={MAX_NAME_LENGTH}
          aria-label="Chat name"
        />
        <button type="submit">Start a chat</button>
      </form>
      <p class="note">To join someone else's chat, scan their code with your camera while they have it on screen.</p>
    </main>
  )
}
