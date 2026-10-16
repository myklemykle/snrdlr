import type {ComponentChildren} from 'preact'
import {clearNotifications, keepPushRegistered, keepRelayToldWhileUsed} from './push'
import {NotificationSettings} from './push-view'
import {useEffect, useRef, useState} from 'preact/hooks'
import {acknowledgeDevice, onChatsChanged, onNewDevices, startSelfSync, type NewDevice} from './devices'
import {claimChat, keepChats, onBackgroundActivity, sweepChats, unclaimChat, type ConnectFor, type KeepStatus} from './background'
import {ChatScreen} from './chat-screen'
import {authFor, chatFromGrant, directAnswerer, newGroupChat} from './chats'
import {admit, isAdmitted} from './gate'
import {cleanName, createIdentity, loadIdentity, MAX_NAME_LENGTH, memberId, type Identity} from './identity'
import {createInvite, inviteFromFragment, inviteToFragment, isInviteFragment, sealJoinRequest, type Invite} from './invite'
import {hostInvite, redeemInvite} from './invite-room'
import {DEFAULT_CHAT_NAME, uniqueChatName} from './names'
import {QrCode} from './qr'
import {MAX_VOLUME, playSound, setSoundChoice, setSoundVolume, SILENT, SOUND_CHOICES, soundChoice, soundVolume} from './sound'
import {chatFromStandingInvite, devMode, isStandingFragment, standingFromFragment} from './standing-invite'
import {installed, onIos, useInstall} from './install'
import {mailboxes} from './mailbox'
import {isDeviceFragment, linkFromFragment, newDeviceTag} from './link-device'
import {DeviceCode, OpenedDeviceLink} from './link-view'
import {JoinByCode} from './scanner'
import {Avatar, ProfileEditor} from './profile-view'
import {latestCards} from './cards'
import type {CardContent} from './envelope'
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
// Long enough for the person who scanned the code to ask again if our answer went astray.
const PAIRING_LINGER_MS = 20_000
// Only one tab per browser keeps the chats connected; the others wait for this lock.
const KEEP_LOCK = 'snrdlr-stay-connected'
const KEEP_SETTING = 'snrdlr.stayConnected'
// Set by an earlier version in a browser whose keys had been copied to the installed app.
const MOVED = 'snrdlr.moved'
function wasMovedOut(): boolean {
  try {
    return localStorage.getItem(MOVED) === '1'
  } catch {
    return false
  }
}
function clearMovedOut(): void {
  try {
    localStorage.removeItem(MOVED)
  } catch {
    // Nothing was kept, then.
  }
}
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

// Safari on an iPhone sometimes never finishes opening the app's storage, typically in a tab it has
// brought back from the background; the page would wait for ever, blank. A fresh load gets past it.
const STUCK_MS = 6000
const STUCK_RELOADED = 'snrdlr.stuckReload'

type Boot =
  | {status: 'loading'; stuck?: boolean}
  | {status: 'blocked'}
  | {status: 'failed'}
  | {status: 'ready'; store: Store; identity: Identity; admitted: boolean}

/** Progress of redeeming the invite in the address bar, if there is one. */
type Join = {status: 'idle'} | {status: 'joining'} | {status: 'failed'} | {status: 'joined'; chatId: string}

export function App() {
  const [boot, setBoot] = useState<Boot>({status: 'loading'})

  useEffect(() => {
    // Still waiting for the storage to open, with nothing else to say about it.
    let waiting = true
    const stuck = setTimeout(() => {
      if (!waiting) return
      setBoot(current => (current.status === 'loading' ? {status: 'loading', stuck: true} : current))
      // Once by itself; if that did not help, the person is asked.
      try {
        if (sessionStorage.getItem(STUCK_RELOADED)) return
        sessionStorage.setItem(STUCK_RELOADED, '1')
        location.reload()
      } catch {
        // Then the person is asked.
      }
    }, STUCK_MS)
    openStore('snrdlr', {
      onBlocked: () => {
        waiting = false
        setBoot(current => (current.status === 'loading' ? {status: 'blocked'} : current))
      },
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
        // A browser whose keys were copied to the installed app, the way that was done before devices
        // were told apart, carries on as another device of the same person.
        if (wasMovedOut() && !secrets.device && !installed()) {
          secrets = {...secrets, device: newDeviceTag()}
          await store.saveIdentity(secrets)
          clearMovedOut()
        }
        // Anyone with a name or a chat was here before the app became invite-only, or has been invited since.
        const established = secrets.name !== '' || (await store.listChats()).length > 0
        setBoot({status: 'ready', store, identity: loadIdentity(secrets), admitted: isAdmitted(established)})
        try {
          sessionStorage.removeItem(STUCK_RELOADED)
        } catch {
          // Only stops a second reload in a row.
        }
      })
      .catch(() => setBoot({status: 'failed'}))
      .finally(() => {
        waiting = false
        clearTimeout(stuck)
      })
    return () => clearTimeout(stuck)
  }, [])

  if (boot.status === 'loading') {
    return (
      <main class="home">
        <h1>snrdlr</h1>
        {boot.stuck && (
          <>
            <p>snrdlr is taking too long to start. This browser sometimes gets stuck opening the app's storage; reloading usually fixes it.</p>
            <div class="row">
              <button type="button" onClick={() => location.reload()}>
                Reload
              </button>
            </div>
          </>
        )}
      </main>
    )
  }
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
    // The address may have changed between the first render and now, with nobody listening yet.
    onHashChange()
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
  // For rooms held open for hours: they answer others but do not announce themselves (transport.ts).
  const listenFor: ConnectFor = chat => async (keys, handlers) =>
    joinChat(keys, handlers, await fetchTurnServers(), authFor(chat, identity), true)

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
      // Anyone who opens one of these chats announces themselves, and this tab answers.
      stop = keepChats({store, identity, connectFor: listenFor, mailbox: mailboxes, onStatus: status => !cancelled && setKeep(status)})
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

  // Keeps this device's chats in step with the person's other devices.
  useEffect(() => {
    if (!named) return
    // Every device of the person listens and none announces, so they keep in step through the relay's
    // store alone, which is how they do it whenever they are not online together anyway.
    const stop = startSelfSync({store, identity, connectFor: listenFor, mailbox: mailboxes})
    return () => void stop()
  }, [named])

  // Keeps the relay told which chats to wake this device for, if notifications are on.
  useEffect(() => {
    if (!named) return
    const stopRegistering = keepPushRegistered(store, identity)
    // And, while the person is using the app here, not to wake any of their devices.
    const stopTelling = keepRelayToldWhileUsed(store, identity, mailboxes)
    return () => {
      stopRegistering()
      stopTelling()
    }
  }, [named])

  // A notification tapped while the app is open: its chat, or the chat list.
  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      const open = (event.data as {open?: unknown} | null)?.open
      if (typeof open === 'string') openChat(open)
      else if (open === null) goHome()
    }
    navigator.serviceWorker?.addEventListener('message', onMessage)
    return () => navigator.serviceWorker?.removeEventListener('message', onMessage)
  }, [])

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
      if (found) {
        setChat(found)
        void clearNotifications(found).catch(() => {})
      } else goHome(true)
    })
    return () => {
      cancelled = true
    }
  }, [hash])

  // Adding a device: this one, or another, depending on which of the two showed the code.
  if (isDeviceFragment(hash)) {
    const link = linkFromFragment(hash)
    if (link) return <OpenedDeviceLink key={hash} link={link} store={store} identity={identity} onClose={() => goHome(true)} />
  }

  const redeeming = join.status !== 'idle' || isInviteFragment(hash) || isStandingFragment(hash)
  if (!admitted && !redeeming) {
    return (
      <main class="home">
        <h1>snrdlr</h1>
        {notice && <p class="error">{notice}</p>}
        <p>snrdlr is invite-only.</p>
        <p>To join, ask someone who already uses it to show you their code, and scan it while it is on their screen.</p>
        <JoinByCode />
        <AddThisBrowser store={store} identity={identity} />
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
      <AddThisBrowser store={store} identity={identity} />
    </main>
  )
}

/** On a device that is nobody yet: become someone who already uses snrdlr elsewhere. */
function AddThisBrowser(props: {store: Store; identity: Identity}) {
  const [open, setOpen] = useState(false)
  if (open) return <DeviceCode role="new" store={props.store} identity={props.identity} onClose={() => setOpen(false)} />
  return (
    <section class="move">
      <h2>Already use snrdlr on another device?</h2>
      <button type="button" onClick={() => setOpen(true)}>
        Add this {installed() ? 'app' : 'browser'} to my snrdlr
      </button>
    </section>
  )
}

/** Choices that apply to the whole app on this device. */
/** Sounds, and below them the rest of what is set up now and then, which the front page hands in. */
function Settings(props: {onClose: () => void; children?: ComponentChildren}) {
  const {onClose, children} = props
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
        {/* Stays in view as the rest scrolls, so closing never means scrolling to the end. */}
        <header class="sheet-head">
          <h2>Settings</h2>
          <button type="button" class="close" aria-label="Close" onClick={onClose}>
            <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true">
              <path d="M6 6l12 12M18 6L6 18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" />
            </svg>
          </button>
        </header>
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
        {children}
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
  // For each direct chat, the other person's card as they show it there: their icon and colour.
  const [cards, setCards] = useState<Record<string, CardContent | undefined>>({})
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
  const [addingDevice, setAddingDevice] = useState(false)
  useUpdateHold(addingDevice)
  const [deviceNews, setDeviceNews] = useState<NewDevice[]>([])
  useEffect(() => onNewDevices(setDeviceNews), [])
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
    const answer = directAnswerer(identity, pairing)
    let host: {close: () => void} | null = null
    void fetchTurnServers().then(turnServers => {
      if (cancelled) return
      host = hostInvite(
        pairing,
        request => {
          const {chat, sealedGrant} = answer(request, takenNames.current, Date.now())
          // Asked again by the same person: answered again, and nothing more to do.
          if (!chat) return sealedGrant
          takenNames.current = [...takenNames.current, chat.name]
          // The room stays a while longer than the screen, so our answer is sure to have gone out, or can
          // be asked for again.
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
    // Direct chats first, then groups, each newest first.
    const stored = (await store.listChats()).sort((a, b) => Number(a.kind !== 'dm') - Number(b.kind !== 'dm'))
    const counts = await Promise.all(stored.map(chat => store.unreadCount(chat, identity.id)))
    const shown = await Promise.all(
      stored.map(async chat => [chat.id, chat.kind === 'dm' && chat.peer ? latestCards(await store.listMessages(chat.id)).get(memberId(chat.peer.signPublic)) : undefined] as const)
    )
    setCards(Object.fromEntries(shown))
    setChats(stored)
    setUnread(Object.fromEntries(stored.map((chat, index) => [chat.id, counts[index]])))
  }
  useEffect(() => {
    void refresh()
    const stopActivity = onBackgroundActivity(() => void refresh())
    const stopChanges = onChatsChanged(() => void refresh())
    return () => {
      stopActivity()
      stopChanges()
    }
  }, [])

  const leave = async (id: string) => {
    // Stops anything still syncing this chat in the background before its history is deleted.
    await claimChat(id)
    await store.deleteChat(id, identity)
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
      {settingsOpen && (
        <Settings onClose={() => setSettingsOpen(false)}>
          <NotificationSettings store={store} identity={identity} />

          <section>
            <h3>Join someone</h3>
            <p class="note">To join someone else's group or chat with them, scan their code while they have it on screen.</p>
            <JoinByCode />
          </section>

          {!installed() && onIos() && (
            <section>
              <h3>Install on this iPhone</h3>
              <p class="note">
                The installed app is what will be able to notify you. Tap the Share button, then <b>Add to Home Screen</b>. Open it from your
                Home Screen and tap <b>Add this app to my snrdlr</b>, then <b>Open in Safari</b>.
              </p>
            </section>
          )}

          <section>
            <h3>Your devices</h3>
            {addingDevice ? (
              <DeviceCode role="existing" store={store} identity={identity} onClose={() => setAddingDevice(false)} />
            ) : (
              <>
                <p class="note">Use snrdlr as yourself on another phone or computer too, with the same chats.</p>
                <button type="button" onClick={() => setAddingDevice(true)}>
                  Add a device
                </button>
              </>
            )}
          </section>

          {install && (
            <section class="install">
              <h3>Install</h3>
              <p class="note">Puts snrdlr on your home screen, where it opens like any other app. Your chats stay as they are.</p>
              <button type="button" onClick={install}>
                Install snrdlr
              </button>
            </section>
          )}

          {(desktop || stay) && (
            <section class="keep">
              <h3>Stay connected</h3>
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
          {devMode() && (
            <label class="footnote">
              <input type="checkbox" checked={update.held} onChange={event => holdUpdates(event.currentTarget.checked)} /> Hold updates in this
              tab (testing)
            </label>
          )}
        </Settings>
      )}
      {profileOpen && <ProfileEditor store={store} identity={identity} onIdentity={onIdentity} onClose={() => setProfileOpen(false)} />}
      {notice && <p class="error">{notice}</p>}
      {deviceNews.map(device => (
        <p class="device-news" role="status" key={device.stream}>
          Another device was added to your snrdlr, {new Date(device.at).toLocaleString()}. If you didn't add it, someone else has your keys
          and can read your chats.{' '}
          <button
            type="button"
            class="inline"
            onClick={() => {
              acknowledgeDevice(device.stream)
              setDeviceNews(news => news.filter(entry => entry !== device))
            }}
          >
            OK
          </button>
        </p>
      ))}

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
          class="start"
          onClick={() => {
            setCopied(false)
            setPairing(createInvite(identity))
          }}
        >
          Chat with one person
        </button>
      )}

      <form class="new-group" onSubmit={start}>
        <button type="submit">Start a group</button>
        <input
          value={name}
          onInput={event => setName(event.currentTarget.value)}
          placeholder="Group name (optional)"
          maxLength={MAX_NAME_LENGTH}
          aria-label="Chat name"
        />
      </form>

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
                <button
                  type="button"
                  class="open"
                  onClick={() => onOpen(chat.id)}
                  // The other person's chosen colour, as a stripe down the side.
                  style={cards[chat.id]?.color ? {boxShadow: `inset 0.3rem 0 0 ${cards[chat.id]!.color}`} : undefined}
                >
                  {chat.kind === 'dm' && chat.peer && <Avatar card={cards[chat.id]} name={chat.name} id={memberId(chat.peer.signPublic)} />}
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

      {update.ready && (
        <p class="footnote">
          {update.held ? 'A newer version is out; updates are held in this tab.' : 'A newer version is out.'}{' '}
          <button type="button" class="inline" onClick={() => location.reload()}>
            Reload to update
          </button>
        </p>
      )}
    </main>
  )
}
