// Keeps chats that are not on screen up to date: on launch and on return to the app, each one's room is
// joined briefly to sync, then left again, so only the open chat holds connections for long.
import type {Identity} from './identity'
import type {ChatKeys} from './keys'
import {openSession, type Wire, type WireHandlers} from './session'
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
}

function syncOnce(
  chat: ChatRecord,
  identity: Identity,
  store: Store,
  connect: (keys: ChatKeys, handlers: WireHandlers) => Wire | Promise<Wire>,
  timing: SweepTiming
): Running {
  let cancelled = false
  const done = (async () => {
    const startedAt = Date.now()
    let lastActivity = startedAt
    let held: number | null = null
    let someoneThere = false
    const session = await openSession({
      chat,
      identity,
      store,
      connect,
      handlers: {
        onMessages: messages => {
          // Only other people's messages count; our own "joined" message is not news.
          const fromOthers = messages.filter(message => message.author !== identity.id).length
          if (held !== null && fromOthers !== held) {
            lastActivity = Date.now()
            listeners.forEach(listener => listener(chat.id))
          }
          held = fromOthers
        },
        onPeersChange: peerIds => {
          if (peerIds.length > 0) someoneThere = true
        },
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
  connect: (keys: ChatKeys, handlers: WireHandlers) => Wire | Promise<Wire>
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
        const task = syncOnce(chat, options.identity, options.store, options.connect, timing)
        running.set(chat.id, task)
        await task.done
      }
    }
    await Promise.all(Array.from({length: CONCURRENT_CHATS}, worker))
  } finally {
    sweeping = false
  }
}
