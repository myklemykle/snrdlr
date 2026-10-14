import {useEffect, useRef, useState} from 'preact/hooks'
import {claimChat, keepChats, onBackgroundActivity, sweepChats, unclaimChat, type ConnectFor, type KeepStatus} from './background'
import {ChatScreen} from './chat-screen'
import {authFor, chatFromGrant, newGroupChat, pairDirect} from './chats'
import {admit, isAdmitted} from './gate'
import {cleanName, createIdentity, loadIdentity, MAX_NAME_LENGTH, type Identity} from './identity'
import {createInvite, inviteFromFragment, inviteToFragment, isInviteFragment, sealJoinRequest, type Invite} from './invite'
import {hostInvite, redeemInvite} from './invite-room'
import {DEFAULT_CHAT_NAME, uniqueChatName} from './names'
import {QrCode} from './qr'
import {MAX_VOLUME, playSound, setSoundChoice, setSoundVolume, SILENT, SOUND_CHOICES, soundChoice, soundVolume} from './sound'
import {chatFromStandingInvite, devMode, isStandingFragment, standingFromFragment} from './standing-invite'
import {installed, onIos, useInstall} from './install'
import {mailboxes} from './mailbox'
import {applyMove, movedOut, packMove, setMovedOut, unpackMove} from './move'
import {JoinByCode} from './scanner'
import {ProfileEditor} from './profile-view'
import {openStore, type ChatRecord, type Store} from './store'
import {joinChat} from './transport'
import {fetchTurnServers} from './turn'
import {holdUpdates, useUpdateHold, useUpdateState, type UpdateState} from './update'

const CHAT_PREFIX = '#c='
const JOIN_TIMEOUT_MS = Number(import.meta.env.VITE_JOIN_TIMEOUT_MS) || 30_000
// How long after one background sync of the other chats before returning to the app starts another.
const SWEEP_INTERVAL_MS = 30_000
// A forgotten "chat with me" code should not stay live indefinitely.
const PAIRING_LIFETIME_MS = 10 * 60 * 1000
// How long the pairing room is kept after someone has scanned the code.
const PAIRING_LINGER_MS = 2000
// Only one tab per browser keeps the chats connected; the others wait for this lock.
const KEEP_LOCK = 'snrdlr-stay-connected'
const KEEP_SETTING = 'snrdlr.stayConnected'
const STALE_INVITE = 'That invite is no longer active. Ask the person inviting you to show a fresh code.'

/** Whether this tab is holding every chat connected: off, queued behind another tab, or doing it. */
type Keep = null | 'waiting' | KeepStatus

function storedStay(): boolean {
  try {
    return localStorage.getItem(KEEP_SETTING) === '1'
  } catch {
    return false
  }
}

type Boot =
  | {status: 'loading'}
  | {status: 'blocked'}
  | {status: 'failed'}
  | {status: 'ready'; store: Store; identity: Identity; admitted: boolean}

/** Progress of redeeming the invite in the address bar, if there is one. */
type Join = {status: 'idle'} | {status: 'joining'} | {status: 'failed'} | {status: 'joined'; chatId: string}

export function App() {
  const [boot, setBoot] = useState<Boot>({status: 'loading'})

  useEffect(() => {
    openStore('snrdlr', {
      onBlocked: () => setBoot(current => (current.status === 'loading' ? {status: 'blocked'} : current)),
      // This tab is the old one: load the new version, which can use the storage as it now is.
      onOutdated: () => location.reload()
    })
      .then(async store => {
        // Keys are made on first launch, before the person is asked for a name, so that an invite can
        // be redeemed straight away while its code is still showing.
        let secrets = await store.getIdentity()
        if (!secrets) {
          const {name, signSecret, dhSecret} = createIdentity()
          secrets = {name, signSecret, dhSecret}
          await store.saveIdentity(secrets)
        }
        // Anyone with a name or a chat was here before the app became invite-only, or has been invited since.
        const established = secrets.name !== '' || (await store.listChats()).length > 0
        setBoot({status: 'ready', store, identity: loadIdentity(secrets), admitted: isAdmitted(established)})
      })
      .catch(() => setBoot({status: 'failed'}))
  }, [])

  if (boot.status === 'loading') return null
  if (boot.status === 'blocked') {
    return (
      <main class="home">
        <h1>snrdlr</h1>
        <p>snrdlr has been updated, and another tab in this browser is still running the old version.</p>
        <p>Reload or close that tab, and this one will carry on by itself.</p>
      </main>
    )
  }
  if (boot.status === 'failed') {
    return (
      <main class="home">
        <h1>snrdlr</h1>
        <p class="error">This browser won't let the app store anything, so it can't keep your chats. Private browsing often causes this.</p>
      </main>
    )
  }
  const {store, admitted} = boot
  // This browser's copy has gone to the installed app; it must not carry on here as well.
  if (movedOut() && !installed()) return <MovedOut store={store} identity={boot.identity} />
  return (
    <Main
      store={store}
      identity={boot.identity}
      admitted={admitted}
      onAdmitted={() => setBoot(current => (current.status === 'ready' ? {...current, admitted: true} : current))}
      onIdentity={identity => setBoot(current => (current.status === 'ready' ? {...current, identity} : current))}
    />
  )
}

/**
 * Redeems an invite as soon as it appears in the address bar, without waiting for the person to
 * finish setting up, because the code only works while the inviter is still showing it.
 */
function useJoin(store: Store, identity: Identity, hash: string): [Join, () => void] {
  const [join, setJoin] = useState<Join>({status: 'idle'})

  useEffect(() => {
    // A standing invite (testing only) needs nobody at the other end: everything is in the link.
    if (isStandingFragment(hash)) {
      const standing = standingFromFragment(hash)
      if (!standing) return setJoin({status: 'failed'})
      let cancelled = false
      setJoin({status: 'joining'})
      void (async () => {
        try {
          const granted = chatFromStandingInvite(standing, identity, Date.now())
          const others = (await store.listChats()).filter(chat => chat.id !== granted.id).map(chat => chat.name)
          const chat = await store.saveChat({...granted, name: uniqueChatName(granted.name, others)})
          if (!cancelled) setJoin({status: 'joined', chatId: chat.id})
        } catch {
          if (!cancelled) setJoin({status: 'failed'})
        }
      })()
      return () => {
        cancelled = true
      }
    }
    if (!isInviteFragment(hash)) return
    const invite = inviteFromFragment(hash)
    if (!invite) return setJoin({status: 'failed'})

    let cancelled = false
    setJoin({status: 'joining'})
    void (async () => {
      try {
        const granted = await redeemInvite(
          invite,
          sealJoinRequest(identity, invite),
          sealed => chatFromGrant(invite, sealed, identity, Date.now()),
          await fetchTurnServers(),
          JOIN_TIMEOUT_MS
        )
        // The name is ours to adjust: it only labels the chat on this device.
        const others = (await store.listChats()).filter(chat => chat.id !== granted.id).map(chat => chat.name)
        const chat = await store.saveChat({...granted, name: uniqueChatName(granted.name, others)})
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

function Main(props: {
  store: Store
  identity: Identity
  /** Whether this device has been invited; until then all it can do is redeem an invite. */
  admitted: boolean
  onAdmitted: () => void
  onIdentity: (identity: Identity) => void
}) {
  const {store, identity, admitted, onAdmitted, onIdentity} = props
  const [hash, setHash] = useState(location.hash)
  const [join, clearJoin] = useJoin(store, identity, hash)
  const named = identity.name !== ''
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

  const connectFor: ConnectFor = chat => async (keys, handlers) =>
    joinChat(keys, handlers, await fetchTurnServers(), authFor(chat, identity))

  const [stay, setStay] = useState(storedStay)
  const [keep, setKeep] = useState<Keep>(null)
  const chooseStay = (on: boolean) => {
    try {
      localStorage.setItem(KEEP_SETTING, on ? '1' : '0')
    } catch {
      // The choice then lasts until the page is closed.
    }
    // A device that holds messages for others should not have its storage cleared under pressure.
    if (on) void navigator.storage?.persist?.()
    setStay(on)
  }

  // Bring the chats that are not on screen up to date at launch and whenever the app comes back.
  useEffect(() => {
    if (!named || stay) return
    let lastSweep = 0
    const sweep = () => {
      if (document.hidden || Date.now() - lastSweep < SWEEP_INTERVAL_MS) return
      lastSweep = Date.now()
      void sweepChats({store, identity, connectFor, mailbox: mailboxes})
    }
    sweep()
    document.addEventListener('visibilitychange', sweep)
    return () => document.removeEventListener('visibilitychange', sweep)
  }, [named, stay])

  // Or, when asked to, hold every chat connected for as long as this tab is open.
  useEffect(() => {
    if (!named || !stay) return
    let cancelled = false
    let stop: (() => Promise<void>) | null = null
    let finished!: () => void
    const untilFinished = new Promise<void>(resolve => (finished = resolve))
    const begin = () => {
      clearTimeout(queued)
      if (cancelled) return
      setKeep({chats: 0, connections: 0})
      stop = keepChats({store, identity, connectFor, mailbox: mailboxes, onStatus: status => !cancelled && setKeep(status)})
      return untilFinished
    }
    // The lock normally arrives at once; only say another tab has it if it does not.
    const queued = setTimeout(() => !cancelled && setKeep('waiting'), 500)
    // Holding the lock also tells the browser this tab is busy, which makes it less likely to be frozen.
    if (navigator.locks) void navigator.locks.request(KEEP_LOCK, begin)
    else void begin()
    return () => {
      cancelled = true
      clearTimeout(queued)
      setKeep(null)
      void Promise.resolve(stop?.()).finally(finished)
    }
  }, [named, stay])

  // A sound for messages arriving in chats that are not on screen.
  useEffect(() => onBackgroundActivity((_chatId, incoming) => incoming && playSound()), [])

  // Joining a chat by invite is what lets a device into the app.
  useEffect(() => {
    if (join.status !== 'joined' || admitted) return
    admit()
    onAdmitted()
  }, [join])

  // Once the invite has been dealt with, take it out of the address bar and history. Someone who is
  // not in yet and whose invite did not work is told so at once, without being asked for a name first.
  useEffect(() => {
    if (join.status === 'failed' && (named || !admitted)) {
      clearJoin()
      setNotice(STALE_INVITE)
      goHome(true)
    } else if (join.status === 'joined' && named) {
      clearJoin()
      openChat(join.chatId, true)
    }
  }, [join, named])

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

  const redeeming = join.status !== 'idle' || isInviteFragment(hash) || isStandingFragment(hash)
  if (!admitted && !redeeming) {
    return (
      <main class="home">
        <h1>snrdlr</h1>
        {notice && <p class="error">{notice}</p>}
        <p>snrdlr is invite-only.</p>
        <p>To join, ask someone who already uses it to show you their code, and scan it while it is on their screen.</p>
        <JoinByCode />
        <MoveIn store={store} />
        <p class="build">Version {__BUILD__}</p>
      </main>
    )
  }
  if (!named) return <Welcome store={store} identity={identity} invited={join.status !== 'idle'} onNamed={onIdentity} />
  if (redeeming) {
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
          onOpenChat={(id, showInvite) => {
            setInviteOnOpen(showInvite ? id : null)
            openChat(id)
          }}
        />
      )
    )
  }
  return (
    <Home
      store={store}
      identity={identity}
      notice={notice}
      stay={stay}
      keep={keep}
      onStay={chooseStay}
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
      onIdentity={onIdentity}
    />
  )
}

function Welcome(props: {store: Store; identity: Identity; invited: boolean; onNamed: (identity: Identity) => void}) {
  const {store, identity, invited, onNamed} = props
  const [name, setName] = useState('')
  const create = async (event: Event) => {
    event.preventDefault()
    const secrets = {name: cleanName(name), signSecret: identity.signSecret, dhSecret: identity.dhSecret}
    await store.saveIdentity(secrets)
    // Asks the browser not to evict our data under storage pressure; it may say no.
    void navigator.storage?.persist?.()
    onNamed(loadIdentity(secrets))
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
      <MoveIn store={store} />
    </main>
  )
}

/** In the installed app, before it is anybody: take over from the copy in the browser by pasting its code. */
function MoveIn(props: {store: Store}) {
  const {store} = props
  const [open, setOpen] = useState(false)
  const [code, setCode] = useState('')
  const [problem, setProblem] = useState<string | null>(null)
  // Only the installed app has a browser copy to take over from.
  if (!installed() && !devMode()) return null
  const moveIn = async (text: string) => {
    setProblem(null)
    try {
      await applyMove(store, unpackMove(text))
      // Start again as the person who has just moved in.
      location.reload()
    } catch (error) {
      setProblem(
        error instanceof Error && error.message === 'already in use'
          ? 'This copy of snrdlr already has chats of its own, so nothing was moved.'
          : "That isn't a code copied from snrdlr. Copy it again in the browser and paste it here."
      )
    }
  }
  const paste = async () => {
    try {
      const text = await navigator.clipboard.readText()
      setCode(text)
      await moveIn(text)
    } catch {
      setProblem("Couldn't read what you copied. Press and hold in the box and choose Paste.")
    }
  }
  if (!open) {
    return (
      <section class="move">
        <h2>Already using snrdlr in your browser?</h2>
        <button type="button" onClick={() => setOpen(true)}>
          Move my chats here
        </button>
      </section>
    )
  }
  return (
    <section class="move">
      <h2>Move my chats here</h2>
      <p class="note">In your browser, open snrdlr and tap "Copy my snrdlr" on its front page. Then come back and paste.</p>
      <form
        onSubmit={event => {
          event.preventDefault()
          void moveIn(code)
        }}
      >
        <button type="button" onClick={paste}>
          Paste
        </button>
        <textarea value={code} onInput={event => setCode(event.currentTarget.value)} rows={3} aria-label="Code copied from snrdlr in the browser" placeholder="or paste the code here" />
        <button type="submit" disabled={!code.trim()}>
          Move in
        </button>
      </form>
      {problem && <p class="error">{problem}</p>}
    </section>
  )
}

/** In the browser, on an iPhone: how to install, and the code that carries everything across. */
function MoveOut(props: {store: Store; identity: Identity}) {
  const {store, identity} = props
  const [problem, setProblem] = useState<string | null>(null)
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(await packMove(store, identity))
      setMovedOut(true)
      // From here on this copy only shows how to finish the move.
      location.reload()
    } catch {
      setProblem("Couldn't copy. Nothing has changed.")
    }
  }
  return (
    <section class="move">
      <h2>Install on this iPhone</h2>
      <p class="note">An installed snrdlr opens from your Home Screen like any app, and is what will be able to notify you. It starts empty, so there are three steps:</p>
      <ol class="steps">
        <li>
          Tap the Share button, then <b>Add to Home Screen</b>.
        </li>
        <li>
          Come back here and tap <b>Copy my snrdlr</b>. That copies your keys and your list of chats.
        </li>
        <li>
          Open snrdlr from your Home Screen, tap <b>Move my chats here</b>, and paste.
        </li>
      </ol>
      <button type="button" onClick={copy}>
        Copy my snrdlr
      </button>
      <p class="note">After copying, snrdlr stops working in this browser, so that there are never two of you. What you copy is your keys: paste it only into snrdlr.</p>
      {problem && <p class="error">{problem}</p>}
    </section>
  )
}

/** What the browser's copy shows once its keys have been copied out. */
function MovedOut(props: {store: Store; identity: Identity}) {
  const {store, identity} = props
  const [copied, setCopied] = useState(false)
  const [undoing, setUndoing] = useState(false)
  const copyAgain = async () => {
    try {
      await navigator.clipboard.writeText(await packMove(store, identity))
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch {
      // The button can simply be tapped again.
    }
  }
  return (
    <main class="home">
      <h1>snrdlr</h1>
      <p>Your snrdlr has been copied, ready to move to the app on your Home Screen.</p>
      <ol class="steps">
        <li>
          If you have not yet: tap the Share button, then <b>Add to Home Screen</b>.
        </li>
        <li>
          Open snrdlr from your Home Screen, tap <b>Move my chats here</b>, and paste.
        </li>
      </ol>
      <p class="note">Your messages come back there as the people you chat with are online. This browser's copy stays switched off, so there are never two of you.</p>
      <div class="row">
        <button type="button" onClick={copyAgain}>
          {copied ? 'Copied' : 'Copy the code again'}
        </button>
        <button type="button" onClick={() => setUndoing(true)}>
          Use snrdlr here instead
        </button>
      </div>
      {undoing && (
        <section class="confirm">
          <p>
            Only do this if you have <b>not</b> pasted the code into the installed app. Using snrdlr in both places makes other people lose some of your
            messages.
          </p>
          <div class="row">
            <button
              type="button"
              class="danger"
              onClick={() => {
                setMovedOut(false)
                location.reload()
              }}
            >
              I haven't pasted it. Use snrdlr here
            </button>
            <button type="button" onClick={() => setUndoing(false)}>
              Cancel
            </button>
          </div>
        </section>
      )}
      <p class="build">Version {__BUILD__}</p>
    </main>
  )
}

/** Choices that apply to the whole app on this device. */
function Settings(props: {onClose: () => void}) {
  const {onClose} = props
  const [sounds, setSounds] = useState(soundChoice)
  const [volume, setVolume] = useState(() => soundVolume(soundChoice()))
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => event.key === 'Escape' && onClose()
    addEventListener('keydown', onKey)
    return () => removeEventListener('keydown', onKey)
  }, [])
  return (
    <div class="sheet-backdrop" onClick={onClose}>
      <section class="sheet" role="dialog" aria-label="Settings" onClick={event => event.stopPropagation()}>
        <h2>Settings</h2>
        <fieldset>
          <legend>Sounds</legend>
          {SOUND_CHOICES.map(choice => (
            <label key={choice}>
              <input
                type="radio"
                name="sounds"
                checked={sounds === choice}
                onChange={() => {
                  setSoundChoice(choice)
                  setSounds(choice)
                  setVolume(soundVolume(choice))
                  // So the choice can be heard straight away.
                  playSound(true)
                }}
              />{' '}
              {choice}
            </label>
          ))}
        </fieldset>
        {sounds !== SILENT && (
          <label class="volume">
            Volume of {sounds}: {Math.round(volume * 100)}%
            <input
              type="range"
              min="0"
              max={MAX_VOLUME * 100}
              step="5"
              value={Math.round(volume * 100)}
              aria-label={`Volume of ${sounds}`}
              onInput={event => {
                const next = Number(event.currentTarget.value) / 100
                setSoundVolume(sounds, next)
                setVolume(next)
              }}
              // On letting go, so the new level can be heard.
              onChange={() => playSound(true)}
            />
          </label>
        )}
        <p class="note">
          {sounds === SILENT ? 'No sounds.' : 'Plays a sound when a message arrives or is sent, while snrdlr is open.'} On a phone, sounds follow the
          silent switch. 100% is each sound as it was made; above that, loud sounds may distort.
        </p>
        <button type="button" onClick={onClose}>
          Done
        </button>
      </section>
    </div>
  )
}

/** How long this tab has been going, and whether it restarted to update: for judging a long test. */
function runningSummary(update: UpdateState, now: number): string {
  const minutes = Math.floor((now - update.startedAt) / 60_000)
  const lasted = minutes < 1 ? 'under a minute' : minutes < 60 ? `${minutes} min` : `${Math.floor(minutes / 60)} h ${minutes % 60} min`
  const since = new Date(update.startedAt).toLocaleTimeString([], {hour: 'numeric', minute: '2-digit'})
  return update.updatedItself
    ? `This tab updated itself at ${since} and has been running for ${lasted} since.`
    : `This tab has been running for ${lasted}, since ${since}.`
}

function keepSummary(keep: Exclude<Keep, null>): string {
  if (keep === 'waiting') return 'Another snrdlr tab in this browser is already doing this.'
  const chats = `${keep.chats} ${keep.chats === 1 ? 'chat' : 'chats'}`
  if (keep.chats === 0) return 'On. There are no chats to keep connected yet.'
  if (keep.connections === 0) return `Keeping ${chats} connected. Nobody else is online right now.`
  return `Keeping ${chats} connected, with ${keep.connections} ${keep.connections === 1 ? 'device' : 'devices'} online.`
}

function Home(props: {
  store: Store
  identity: Identity
  notice: string | null
  stay: boolean
  keep: Keep
  onStay: (on: boolean) => void
  onOpen: (id: string) => void
  onCreate: (id: string) => void
  onIdentity: (identity: Identity) => void
}) {
  const {store, identity, notice, stay, keep, onStay, onOpen, onCreate, onIdentity} = props
  // Offered on computers only: a phone's browser stops the page as soon as it is out of sight.
  const [desktop] = useState(() => matchMedia('(hover: hover) and (pointer: fine)').matches)
  const [chats, setChats] = useState<ChatRecord[] | null>(null)
  const [unread, setUnread] = useState<Record<string, number>>({})
  const [name, setName] = useState('')
  const [leaving, setLeaving] = useState<string | null>(null)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [profileOpen, setProfileOpen] = useState(false)
  const install = useInstall()
  useUpdateHold(profileOpen)
  const update = useUpdateState()
  // The "running for" line is the only thing here that changes by the clock.
  const [now, setNow] = useState(Date.now)
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 60_000)
    return () => clearInterval(timer)
  }, [])
  const [pairing, setPairing] = useState<Invite | null>(null)
  // A code on screen must not be wiped away by the tab reloading to update.
  useUpdateHold(pairing !== null)
  const [copied, setCopied] = useState(false)
  const takenNames = useRef<string[]>([])
  takenNames.current = (chats ?? []).map(chat => chat.name)

  // While the "chat with me" code is showing, whoever scans it gets a direct chat with us, and we go
  // straight to that chat. Hiding the code forgets the token, so it stops working.
  useEffect(() => {
    if (!pairing) return
    let cancelled = false
    let used = false
    let host: {close: () => void} | null = null
    void fetchTurnServers().then(turnServers => {
      if (cancelled) return
      host = hostInvite(
        pairing,
        request => {
          // One showing of the code makes one chat: a second person scanning it a moment later is turned away.
          if (used) throw new Error('code already used')
          const {chat, sealedGrant} = pairDirect(identity, pairing, request, takenNames.current, Date.now())
          used = true
          takenNames.current = [...takenNames.current, chat.name]
          // The room stays a moment longer than the screen, so our answer is sure to have gone out.
          const answering = host
          host = null
          setTimeout(() => answering?.close(), PAIRING_LINGER_MS)
          void store.saveChat(chat).then(saved => {
            if (cancelled) return
            setPairing(null)
            onOpen(saved.id)
          })
          return sealedGrant
        },
        turnServers
      )
    })
    const timer = setTimeout(() => setPairing(null), PAIRING_LIFETIME_MS)
    return () => {
      cancelled = true
      clearTimeout(timer)
      host?.close()
    }
  }, [pairing])

  const pairingUrl = pairing ? location.origin + location.pathname + inviteToFragment(pairing) : ''
  const copyPairing = async () => {
    try {
      await navigator.clipboard.writeText(pairingUrl)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch {
      // Copying is a convenience; the code itself still works.
    }
  }

  const refresh = async () => {
    const stored = await store.listChats()
    const counts = await Promise.all(stored.map(chat => store.unreadCount(chat, identity.id)))
    setChats(stored)
    setUnread(Object.fromEntries(stored.map((chat, index) => [chat.id, counts[index]])))
  }
  useEffect(() => {
    void refresh()
    return onBackgroundActivity(() => void refresh())
  }, [])

  const leave = async (id: string) => {
    // Stops anything still syncing this chat in the background before its history is deleted.
    await claimChat(id)
    await store.deleteChat(id, identity.id)
    unclaimChat(id)
    setLeaving(null)
    await refresh()
  }

  const start = async (event: Event) => {
    event.preventDefault()
    const taken = (await store.listChats()).map(chat => chat.name)
    const chat = await store.saveChat(newGroupChat(identity, cleanName(name) || DEFAULT_CHAT_NAME, taken, Date.now()))
    onCreate(chat.id)
  }

  return (
    <main class="home">
      <h1>snrdlr</h1>
      <p class="greeting">
        <span class="hello">Hello, {identity.name}.</span>
        <button type="button" class="gear" aria-label="Your profile" onClick={() => setProfileOpen(true)}>
          <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round">
            <circle cx="12" cy="8" r="4" />
            <path d="M4 21c.6-4.2 3.8-6.5 8-6.5s7.400 2.300 8 6.500" />
          </svg>
        </button>
        <button type="button" class="gear" aria-label="Settings" onClick={() => setSettingsOpen(true)}>
          <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round">
            <circle cx="12" cy="12" r="3.2" />
            <path d="M19.4 13.5a7.6 7.6 0 0 0 0-3l2-1.5-2-3.4-2.3.9a7.6 7.6 0 0 0-2.6-1.5L14.1 2.5h-4.2l-.4 2.5a7.6 7.6 0 0 0-2.6 1.5l-2.3-.9-2 3.4 2 1.5a7.6 7.6 0 0 0 0 3l-2 1.5 2 3.4 2.3-.9a7.6 7.6 0 0 0 2.6 1.5l.4 2.5h4.2l.4-2.5a7.6 7.6 0 0 0 2.6-1.5l2.3.9 2-3.4z" />
          </svg>
        </button>
      </p>
      {settingsOpen && <Settings onClose={() => setSettingsOpen(false)} />}
      {profileOpen && <ProfileEditor store={store} identity={identity} onIdentity={onIdentity} onClose={() => setProfileOpen(false)} />}
      {notice && <p class="error">{notice}</p>}

      {chats && chats.length > 0 && <h2>Your chats</h2>}
      {chats && chats.length > 0 && (
        <ul class="chats" aria-label="Your chats">
          {chats.map(chat =>
            leaving === chat.id ? (
              <li key={chat.id} class="confirm">
                <p>
                  Leave "{chat.name}"? The chat and its history will be deleted from this device. Other members keep their copies.
                </p>
                <button type="button" class="danger" onClick={() => leave(chat.id)}>
                  Leave chat
                </button>
                <button type="button" onClick={() => setLeaving(null)}>
                  Cancel
                </button>
              </li>
            ) : (
              <li key={chat.id}>
                <button type="button" class="open" onClick={() => onOpen(chat.id)}>
                  <span class="name">{chat.name}</span>
                  {chat.kind === 'dm' && <span class="tag">direct</span>}
                  {unread[chat.id] > 0 && (
                    <span class="unread" aria-label={`${unread[chat.id]} unread`}>
                      {unread[chat.id]}
                    </span>
                  )}
                </button>
                <button type="button" class="leave" onClick={() => setLeaving(chat.id)} aria-label={`Leave ${chat.name}`}>
                  Leave
                </button>
              </li>
            )
          )}
        </ul>
      )}

      <h2>Chat with one person</h2>
      {pairing ? (
        <section class="invite">
          <QrCode text={pairingUrl} label="Code to chat with me" />
          <p>Whoever scans this while it is on your screen starts a direct chat with you, and it opens here too. It stops working when you hide it.</p>
          <button type="button" onClick={copyPairing}>
            {copied ? 'Copied' : 'Copy link'}
          </button>{' '}
          <button type="button" onClick={() => setPairing(null)}>
            Hide my code
          </button>
        </section>
      ) : (
        <button
          type="button"
          onClick={() => {
            setCopied(false)
            setPairing(createInvite(identity))
          }}
        >
          Show my code
        </button>
      )}

      <h2>New group</h2>
      <form onSubmit={start}>
        <input
          value={name}
          onInput={event => setName(event.currentTarget.value)}
          placeholder="Name (optional)"
          maxLength={MAX_NAME_LENGTH}
          aria-label="Chat name"
        />
        <button type="submit">Start a group</button>
      </form>
      <h2>Join someone</h2>
      <p class="note">To join someone else's group or chat with them, scan their code while they have it on screen.</p>
      <JoinByCode />

      {!installed() && (onIos() || devMode()) && <MoveOut store={store} identity={identity} />}

      {install && (
        <section class="install">
          <h2>Install</h2>
          <p class="note">Puts snrdlr on your home screen, where it opens like any other app. Your chats stay as they are.</p>
          <button type="button" onClick={install}>
            Install snrdlr
          </button>
        </section>
      )}

      {(desktop || stay) && (
        <section class="keep">
          <h2>Stay connected</h2>
          <label>
            <input type="checkbox" checked={stay} onChange={event => onStay(event.currentTarget.checked)} /> Keep every chat connected while
            this tab is open
          </label>
          {keep && (
            <p class="keeping" role="status">
              {keepSummary(keep)}
            </p>
          )}
          {keep && <p class="note running">{runningSummary(update, now)}</p>}
          <p class="note">
            For a computer that stays on. People in your chats who are never online at the same time still get each other's messages,
            because this computer holds them in between. Leave this tab open and keep the computer from sleeping.
          </p>
        </section>
      )}
      <p class="build">
        Version {__BUILD__}
        {devMode() && ' · developer mode'}
      </p>
      {update.ready && (
        <p class="footnote">
          {update.held ? 'A newer version is out; updates are held in this tab.' : 'A newer version is out.'}{' '}
          <button type="button" class="inline" onClick={() => location.reload()}>
            Reload to update
          </button>
        </p>
      )}
      {devMode() && (
        <label class="footnote">
          <input type="checkbox" checked={update.held} onChange={event => holdUpdates(event.currentTarget.checked)} /> Hold updates in this tab
          (testing)
        </label>
      )}
    </main>
  )
}
