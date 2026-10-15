// Notifications: a device asks our relay to wake it, through the browser's push service, when a
// message is left there for one of its chats (worker-relay/src/relay.ts). The push says only which
// chat; the service worker (public/sw.js) shows the chat's name, and the app fetches the message itself
// when opened. Nothing in a push can be read by the push service, and the relay never sees a message.
//
// On an iPhone only the Home Screen app can be woken. Its notifications can open the chat in Safari,
// where most people keep their chats, because the app can open Safari though a notification cannot.
import {deriveChatKeys} from './keys'
import type {RelayMailboxes} from './mailbox'
import type {Identity} from './identity'
import {installed, onIos} from './install'
import {PUSH_PUBLIC_KEY} from './push-key'
import {pushTag} from './push-tag'
import {RELAYS} from './relays'
import type {ChatRecord, Store} from './store'

export type PushState =
  /** This browser cannot be woken, or the relay has no key yet. */
  | 'unsupported'
  /** An iPhone's browser: only the Home Screen app can be woken. */
  | 'install-first'
  | 'off'
  /** The person said no, which only the browser's settings can undo. */
  | 'blocked'
  | 'on'

const SENT = 'snrdlr.push.sent'
const SAFARI = 'snrdlr.push.safari'
/** Registrations are renewed this often while the app is used, so the relay does not forget the device. */
const RENEW_MS = 24 * 3600_000
const ANSWER_MS = 10_000
/** Where the service worker finds what it needs to word a notification and open its chat. */
export const LABELS_CACHE = 'snrdlr-push'
const LABELS_KEY = 'labels'

const storeRelay = import.meta.env?.VITE_STORE_RELAY?.trim() || RELAYS[0]

function local(key: string, value?: string | null): string | null {
  try {
    if (value === null) localStorage.removeItem(key)
    else if (value !== undefined) localStorage.setItem(key, value)
    return localStorage.getItem(key)
  } catch {
    return null
  }
}

async function registration(): Promise<ServiceWorkerRegistration | null> {
  if (!('serviceWorker' in navigator)) return null
  // The service worker is only registered in a real build; without one, there is nothing to wait for.
  const timeout = new Promise<null>(resolve => setTimeout(() => resolve(null), 3000))
  return Promise.race([navigator.serviceWorker.ready, timeout])
}

export async function pushState(): Promise<PushState> {
  if (onIos() && !installed()) return 'install-first'
  if (!PUSH_PUBLIC_KEY || !('PushManager' in globalThis) || !('Notification' in globalThis)) return 'unsupported'
  if (Notification.permission === 'denied') return 'blocked'
  const reg = await registration()
  if (!reg) return 'unsupported'
  return Notification.permission === 'granted' && (await reg.pushManager.getSubscription()) ? 'on' : 'off'
}

const keyBytes = (base64url: string) =>
  Uint8Array.from(atob(base64url.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (base64url.length % 4)) % 4)), char => char.charCodeAt(0))

/** Asks to be allowed to notify, then subscribes and tells the relay. Must be called from a tap. */
export async function turnOnPush(store: Store, identity: Identity): Promise<PushState> {
  if ((await Notification.requestPermission()) !== 'granted') return pushState()
  const reg = await registration()
  if (!reg) return 'unsupported'
  await reg.pushManager.subscribe({userVisibleOnly: true, applicationServerKey: keyBytes(PUSH_PUBLIC_KEY)})
  await registerPush(store, identity, true)
  return pushState()
}

export async function turnOffPush(): Promise<PushState> {
  const subscription = await (await registration())?.pushManager.getSubscription()
  if (subscription) {
    await tellRelay(['UNPUSH', subscription.endpoint]).catch(() => false)
    await subscription.unsubscribe()
  }
  local(SENT, null)
  return pushState()
}

/** Whether a notification tapped in the iPhone's Home Screen app opens the chat in Safari. */
export const opensInSafari = () => onIos() && installed() && local(SAFARI) !== '0'
export function setOpensInSafari(on: boolean, store: Store, identity: Identity) {
  local(SAFARI, on ? '1' : '0')
  void registerPush(store, identity, true)
}

/** Sends one message to the relay on a connection of its own, and waits for its answer. */
function tellRelay(message: unknown[]): Promise<boolean> {
  return new Promise(resolve => {
    let socket: WebSocket
    try {
      socket = new WebSocket(storeRelay)
    } catch {
      return resolve(false)
    }
    const done = (ok: boolean) => {
      clearTimeout(timer)
      socket.close()
      resolve(ok)
    }
    const timer = setTimeout(() => done(false), ANSWER_MS)
    socket.onopen = () => socket.send(JSON.stringify(message))
    socket.onmessage = ({data}) => {
      try {
        const [type, ok] = JSON.parse(String(data)) as [string, unknown]
        if (type === 'PUSH' || type === 'NOTICE') done(type === 'PUSH' && ok === true)
      } catch {
        // Not the answer.
      }
    }
    socket.onerror = () => done(false)
  })
}

/** What the service worker is told about each chat, by the topic its pushes name. */
export type Labels = {safari: boolean; chats: Record<string, {id: string; name: string}>}

const topicOf = (chat: ChatRecord) => deriveChatKeys(chat.secret, chat.context).storeTopic

/**
 * Tells the relay which chats this device wants to be woken for, when that has changed or not been
 * said for a while (or always, with `force`), and leaves the chats' names for the service worker.
 */
export async function registerPush(store: Store, identity: Identity, force = false): Promise<void> {
  const reg = await registration()
  const subscription = await reg?.pushManager.getSubscription()
  if (!subscription || Notification.permission !== 'granted') return
  const chats = await store.listChats()
  const labels: Labels = {safari: opensInSafari(), chats: {}}
  for (const chat of chats) labels.chats[topicOf(chat)] = {id: chat.id, name: chat.name}
  await (await caches.open(LABELS_CACHE)).put(LABELS_KEY, new Response(JSON.stringify(labels), {headers: {'Content-Type': 'application/json'}}))

  const {endpoint, keys} = subscription.toJSON() as {endpoint: string; keys: {p256dh: string; auth: string}}
  const topics = chats.map(chat => [topicOf(chat), pushTag(chat, identity)]).sort((a, b) => a[0].localeCompare(b[0]))
  const said = JSON.stringify({endpoint, topics})
  let last: {said: string; at: number} | null = null
  try {
    last = JSON.parse(local(SENT) ?? 'null')
  } catch {
    // Said again.
  }
  if (!force && last?.said === said && Date.now() - last.at < RENEW_MS) return
  if (await tellRelay(['PUSH', {endpoint, p256dh: keys.p256dh, auth: keys.auth}, topics])) local(SENT, JSON.stringify({said, at: Date.now()}))
}

/** Clears a chat's notifications once it is opened here. */
export async function clearNotifications(chat: ChatRecord): Promise<void> {
  const reg = await registration()
  for (const shown of (await reg?.getNotifications({tag: topicOf(chat)})) ?? []) shown.close()
}

/** Someone who has not touched the app for this long is not using it, even if it is on screen. */
const IDLE_MS = 2 * 60_000
/**
 * How long the relay holds back notifications after being told; renewed well before it runs out. It is
 * told at once when the app is put away or left idle, so the length only matters if the app is closed
 * without warning. The relay rewrites its record only once less than half is left.
 */
const AWAKE_SECONDS = 180
const AWAKE_EVERY_MS = 60_000

/**
 * While the person is using the app here, has it on screen and has touched it lately, tells the relay
 * so, and the relay wakes none of their devices for these chats meanwhile. They see and hear what
 * arrives here. Returns a stop function.
 */
export function keepRelayToldWhileUsed(store: Store, identity: Identity, relay: RelayMailboxes): () => void {
  let lastInput = Date.now()
  let told = false
  const entries = async () => (await store.listChats()).map(chat => [topicOf(chat), pushTag(chat, identity)])
  const tell = async (using: boolean) => {
    if (!using && !told) return
    const list = await entries()
    if (list.length > 0 && relay.say(['AWAKE', list, using ? AWAKE_SECONDS : 0])) told = using
  }
  const using = () => document.visibilityState === 'visible' && Date.now() - lastInput < IDLE_MS
  const check = () => void tell(using()).catch(() => {})
  const onInput = () => {
    const wasIdle = Date.now() - lastInput >= IDLE_MS
    lastInput = Date.now()
    // Back after a while: say so now rather than at the next check.
    if (wasIdle || !told) check()
  }
  const moments = ['pointerdown', 'keydown', 'touchstart', 'wheel', 'scroll'] as const
  for (const moment of moments) addEventListener(moment, onInput, {capture: true, passive: true})
  document.addEventListener('visibilitychange', check)
  const timer = setInterval(check, AWAKE_EVERY_MS)
  check()
  return () => {
    clearInterval(timer)
    for (const moment of moments) removeEventListener(moment, onInput, {capture: true})
    document.removeEventListener('visibilitychange', check)
    void tell(false).catch(() => {})
  }
}

/** Keeps the relay up to date with this device's chats while the app is open. Returns a stop function. */
export function keepPushRegistered(store: Store, identity: Identity, everyMs = 15_000): () => void {
  const check = () => void registerPush(store, identity).catch(() => {})
  check()
  const timer = setInterval(check, everyMs)
  return () => clearInterval(timer)
}
