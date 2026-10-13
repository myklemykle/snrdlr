// Keeps chats that are not on screen up to date, in one of two ways.
//
// Sweep: on launch and on return to the app, each chat's room is joined briefly to sync, then left
// again, so only the open chat holds connections for long. This is what phones do.
//
// Keep: every chat's room stays joined for as long as the page is open. A computer left running this
// way is always there to take a message from one member and hand it to another who comes online
// later. It is an ordinary member doing what any member's device does for the chat on screen.
import type {Identity} from './identity'
import type {ChatKeys} from './keys'
import {openSession, type Session, type Wire, type WireHandlers} from './session'

/** Makes the connection function for one chat; each chat has its own membership check. */
export type ConnectFor = (chat: ChatRecord) => (keys: ChatKeys, handlers: WireHandlers) => Wire | Promise<Wire>
import type {ChatRecord, Store} from './store'

export type SweepTiming = {
  /** Give up on a chat where nobody has appeared after this long. */
  aloneMs: number
  /** Once someone is there, leave after this long without a new message… */
  quietMs: number
  /** …but stay at least this long, and at most this long. */
  minMs: number
  maxMs: number
  pollMs: number
}

const DEFAULT_TIMING: SweepTiming = {aloneMs: 6_000, quietMs: 2_500, minMs: 4_000, maxMs: 20_000, pollMs: 250}
const CONCURRENT_CHATS = 2

type Running = {cancel: () => void; done: Promise<void>}

const running = new Map<string, Running>()
const foreground = new Set<string>()
const listeners = new Set<(chatId: string) => void>()
let sweeping = false
/** Set while chats are being kept connected, so a chat leaving the screen is picked up at once. */
let keeperCheck: (() => void) | null = null

/** Calls back whenever a chat that is not on screen receives something. */
export function onBackgroundActivity(listener: (chatId: string) => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/** Reserves a chat for the screen showing it, stopping any background sync of it first. */
export async function claimChat(chatId: string): Promise<void> {
  foreground.add(chatId)
  const current = running.get(chatId)
  current?.cancel()
  await current?.done
}

export function unclaimChat(chatId: string): void {
  foreground.delete(chatId)
  keeperCheck?.()
}

/** Tells listeners when other people's messages arrive in a chat that is not on screen. */
function announceNews(chatId: string, selfId: string, onNews?: () => void) {
  let held: number | null = null
  return (messages: {author: string}[]) => {
    // Only other people's messages count; our own "joined" message is not news.
    const fromOthers = messages.filter(message => message.author !== selfId).length
    if (held !== null && fromOthers !== held) {
      onNews?.()
      listeners.forEach(listener => listener(chatId))
    }
    held = fromOthers
  }
}

function syncOnce(
  chat: ChatRecord,
  identity: Identity,
  store: Store,
  connectFor: ConnectFor,
  timing: SweepTiming
): Running {
  let cancelled = false
  const done = (async () => {
    const startedAt = Date.now()
    let lastActivity = startedAt
    let someoneThere = false
    const session = await openSession({
      chat,
      identity,
      store,
      connect: connectFor(chat),
      handlers: {
        onMessages: announceNews(chat.id, identity.id, () => (lastActivity = Date.now())),
        onPeersChange: peerIds => {
          if (peerIds.length > 0) someoneThere = true
        },
        // A picture still arriving is a reason to stay a little longer.
        onFiles: () => (lastActivity = Date.now()),
        onStatus: () => {},
        onError: () => {}
      }
    })
    while (!cancelled) {
      await new Promise(resolve => setTimeout(resolve, timing.pollMs))
      const now = Date.now()
      const elapsed = now - startedAt
      if (elapsed >= timing.maxMs) break
      if (!someoneThere && elapsed >= timing.aloneMs) break
      if (someoneThere && elapsed >= timing.minMs && now - lastActivity >= timing.quietMs) break
    }
    await session.close()
  })()
    .catch(() => {})
    .finally(() => running.delete(chat.id))
  return {cancel: () => (cancelled = true), done}
}

/** Syncs every stored chat that is not currently on screen. Does nothing if a sweep is already under way. */
export async function sweepChats(options: {
  store: Store
  identity: Identity
  connectFor: ConnectFor
  timing?: Partial<SweepTiming>
}): Promise<void> {
  if (sweeping) return
  sweeping = true
  try {
    const timing = {...DEFAULT_TIMING, ...options.timing}
    const queue = await options.store.listChats()
    const worker = async () => {
      for (let chat = queue.shift(); chat; chat = queue.shift()) {
        if (foreground.has(chat.id) || running.has(chat.id)) continue
        const task = syncOnce(chat, options.identity, options.store, options.connectFor, timing)
        running.set(chat.id, task)
        await task.done
      }
    }
    await Promise.all(Array.from({length: CONCURRENT_CHATS}, worker))
  } finally {
    sweeping = false
  }
}

export type KeepTiming = {
  /** How often to look for chats that were added, left, or came off screen. */
  pollMs: number
  /** A gap between checks longer than this means the computer slept, so connections need testing. */
  sleepGapMs: number
  /** Rejoin a room after this long with nobody connected, or this long regardless… */
  refreshQuietMs: number
  /** …because the relay credentials a room was joined with expire after four hours. */
  refreshMaxMs: number
}

// A hidden tab's timers may fire only once a minute, so the sleep gap has to be well above that.
const DEFAULT_KEEP_TIMING: KeepTiming = {pollMs: 3_000, sleepGapMs: 150_000, refreshQuietMs: 2 * 3600_000, refreshMaxMs: 3 * 3600_000}

export type KeepStatus = {
  /** Chats being held connected, not counting the one on screen. */
  chats: number
  /** Connections to other people's devices across those chats. */
  connections: number
}

type Held = Running & {openedAt: number; peers: () => number; resume: (awayMs: number) => void}

function hold(chat: ChatRecord, identity: Identity, store: Store, connectFor: ConnectFor, onChange: () => void): Held {
  let release!: () => void
  const released = new Promise<void>(resolve => (release = resolve))
  let session: Session | null = null
  let peers = 0
  const done = (async () => {
    session = await openSession({
      chat,
      identity,
      store,
      connect: connectFor(chat),
      handlers: {
        onMessages: announceNews(chat.id, identity.id),
        onPeersChange: peerIds => {
          peers = peerIds.length
          onChange()
        },
        onStatus: () => {},
        onError: () => {}
      }
    })
    await released
    await session.close()
  })().catch(() => {})
  return {cancel: release, done, openedAt: Date.now(), peers: () => peers, resume: awayMs => void session?.resume(awayMs).catch(() => {})}
}

/**
 * Holds every stored chat connected until the returned function is called, apart from whichever chat is
 * on screen, which its own screen holds. Run it in one place at a time.
 */
export function keepChats(options: {
  store: Store
  identity: Identity
  connectFor: ConnectFor
  onStatus?: (status: KeepStatus) => void
  timing?: Partial<KeepTiming>
}): () => Promise<void> {
  const {store, identity, connectFor} = options
  const timing = {...DEFAULT_KEEP_TIMING, ...options.timing}
  const held = new Map<string, Held>()
  let stopped = false
  let checking = false
  let checkAgain = false
  let lastTick = Date.now()

  const report = () => {
    if (stopped) return
    options.onStatus?.({chats: held.size, connections: [...held.values()].reduce((sum, task) => sum + task.peers(), 0)})
  }

  const drop = async (chatId: string) => {
    const task = held.get(chatId)
    task?.cancel()
    await task?.done
  }

  const check = async () => {
    if (stopped) return
    if (checking) return void (checkAgain = true)
    checking = true
    try {
      const chats = await store.listChats()
      const stored = new Set(chats.map(chat => chat.id))
      // A chat that was left on this device is let go.
      for (const chatId of held.keys()) if (!stored.has(chatId)) await drop(chatId)
      for (const chat of chats) {
        if (stopped) return
        const mine = held.get(chat.id)
        if (mine) {
          const age = Date.now() - mine.openedAt
          const stale = age >= timing.refreshMaxMs || (age >= timing.refreshQuietMs && mine.peers() === 0)
          if (!stale) continue
          await drop(chat.id)
        }
        // The chat's own screen has it, or a sweep does until it finishes.
        if (stopped || foreground.has(chat.id) || running.has(chat.id)) continue
        const task = hold(chat, identity, store, connectFor, report)
        running.set(chat.id, task)
        held.set(chat.id, task)
        void task.done.finally(() => {
          if (running.get(chat.id) === task) running.delete(chat.id)
          if (held.get(chat.id) === task) held.delete(chat.id)
          report()
        })
      }
    } catch {
      // Storage hiccup: the next check tries again.
    } finally {
      checking = false
      report()
      if (checkAgain) {
        checkAgain = false
        void check()
      }
    }
  }

  const resumeAll = (awayMs: number) => held.forEach(task => task.resume(awayMs))
  const onOnline = () => resumeAll(Infinity)
  const timer = setInterval(() => {
    const now = Date.now()
    const gap = now - lastTick - timing.pollMs
    lastTick = now
    if (gap >= timing.sleepGapMs) resumeAll(gap)
    void check()
  }, timing.pollMs)
  globalThis.addEventListener?.('online', onOnline)
  keeperCheck = () => void check()
  void check()

  return async () => {
    stopped = true
    keeperCheck = null
    clearInterval(timer)
    globalThis.removeEventListener?.('online', onOnline)
    const tasks = [...held.values()]
    tasks.forEach(task => task.cancel())
    await Promise.all(tasks.map(task => task.done))
  }
}
