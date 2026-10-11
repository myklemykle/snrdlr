import {useEffect, useState} from 'preact/hooks'
import {ChatScreen} from './chat-screen'
import {cleanName, createIdentity, loadIdentity, MAX_NAME_LENGTH, type Identity} from './identity'
import {inviteFromFragment} from './invite'
import {deriveChatKeys, generateGroupSecret} from './keys'
import {openStore, type ChatRecord, type Store} from './store'

const CHAT_PREFIX = '#c='
const INVITE_PREFIX = '#i='

type Boot = {status: 'loading'} | {status: 'failed'} | {status: 'ready'; store: Store; identity: Identity | null}

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
  const {store, identity} = boot
  if (!identity) return <Welcome onCreate={created => setBoot({status: 'ready', store, identity: created})} store={store} />
  return <Router store={store} identity={identity} />
}

function Welcome({store, onCreate}: {store: Store; onCreate: (identity: Identity) => void}) {
  const [name, setName] = useState('')
  const joining = location.hash.startsWith(INVITE_PREFIX)
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
      <p>{joining ? 'You have been invited to a chat. What should people call you?' : 'What should people call you?'}</p>
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

function Router({store, identity}: {store: Store; identity: Identity}) {
  const [hash, setHash] = useState(location.hash)
  const [chat, setChat] = useState<ChatRecord | null>(null)
  const [notice, setNotice] = useState<string | null>(null)

  useEffect(() => {
    const onHashChange = () => setHash(location.hash)
    addEventListener('hashchange', onHashChange)
    return () => removeEventListener('hashchange', onHashChange)
  }, [])

  const openChat = (id: string, replace = false) => {
    // Replacing drops the invite, and with it the chat's secret, from the address bar and history.
    if (replace) history.replaceState(null, '', CHAT_PREFIX + id)
    else history.pushState(null, '', CHAT_PREFIX + id)
    setHash(CHAT_PREFIX + id)
  }
  const goHome = () => {
    history.pushState(null, '', location.pathname + location.search)
    setHash('')
  }

  useEffect(() => {
    let cancelled = false
    void (async () => {
      if (hash.startsWith(INVITE_PREFIX)) {
        const invite = inviteFromFragment(hash)
        if (!invite) {
          setNotice("That invite link isn't valid.")
          return goHome()
        }
        const saved = await store.saveChat({
          id: deriveChatKeys(invite.secret).roomId,
          secret: invite.secret,
          name: invite.name,
          createdAt: Date.now()
        })
        if (!cancelled) openChat(saved.id, true)
      } else if (hash.startsWith(CHAT_PREFIX)) {
        const found = await store.getChat(hash.slice(CHAT_PREFIX.length))
        if (cancelled) return
        if (found) setChat(found)
        else goHome()
      } else {
        setChat(null)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [hash])

  if (hash.startsWith(INVITE_PREFIX)) return null
  if (hash.startsWith(CHAT_PREFIX)) {
    const current = chat?.id === hash.slice(CHAT_PREFIX.length) ? chat : null
    return current && <ChatScreen key={current.id} chat={current} identity={identity} store={store} onBack={goHome} />
  }
  return <Home store={store} identity={identity} notice={notice} onOpen={openChat} />
}

function Home(props: {store: Store; identity: Identity; notice: string | null; onOpen: (id: string) => void}) {
  const {store, identity, notice, onOpen} = props
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
    onOpen(chat.id)
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
      <p class="note">To join someone else's chat, scan their code with your camera.</p>
    </main>
  )
}
