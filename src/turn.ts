import type {TurnServerConfig} from 'trystero/nostr'

const CHALLENGE_TIMEOUT_MS = 8000
const MESSAGE_TYPE = 'snrdlr-turn'
const CACHE_KEY = 'snrdlr.turn'
// Reuse credentials for an hour; the worker issues them for four, so cached ones stay valid in use.
const CACHE_MS = 60 * 60 * 1000

function isIceServer(value: unknown): value is TurnServerConfig {
  if (typeof value !== 'object' || value === null) return false
  const {urls, username, credential} = value as Record<string, unknown>
  return (
    Array.isArray(urls) &&
    urls.every(url => typeof url === 'string') &&
    (username === undefined || typeof username === 'string') &&
    (credential === undefined || typeof credential === 'string')
  )
}

export function parseIceServers(value: unknown): TurnServerConfig[] {
  return Array.isArray(value) ? value.filter(isIceServer) : []
}

function readCache(now: number): TurnServerConfig[] {
  try {
    const cached = JSON.parse(sessionStorage.getItem(CACHE_KEY) ?? 'null') as {at?: unknown; iceServers?: unknown} | null
    if (typeof cached?.at !== 'number' || now - cached.at > CACHE_MS || now < cached.at) return []
    return parseIceServers(cached.iceServers)
  } catch {
    return []
  }
}

function writeCache(now: number, iceServers: TurnServerConfig[]) {
  try {
    sessionStorage.setItem(CACHE_KEY, JSON.stringify({at: now, iceServers}))
  } catch {
    // Storage can be unavailable (private mode); the next join just runs the challenge again.
  }
}

/**
 * Runs the worker's bot check in a hidden cross-origin iframe and waits for it to post back TURN servers.
 * The iframe keeps Cloudflare's challenge script out of this origin, where the chat keys live.
 */
function requestFromWorker(workerUrl: string): Promise<TurnServerConfig[]> {
  return new Promise(resolve => {
    const workerOrigin = new URL(workerUrl).origin
    const frame = document.createElement('iframe')
    frame.src = `${workerOrigin}/challenge?origin=${encodeURIComponent(location.origin)}`
    // No top-navigation or popups; same-origin keeps the frame on the worker's own origin, not ours.
    frame.sandbox.add('allow-scripts', 'allow-same-origin')
    frame.setAttribute('aria-hidden', 'true')
    frame.tabIndex = -1
    frame.style.cssText = 'position:absolute;width:1px;height:1px;opacity:0;border:0;pointer-events:none'

    const finish = (iceServers: TurnServerConfig[]) => {
      clearTimeout(timer)
      removeEventListener('message', onMessage)
      frame.remove()
      resolve(iceServers)
    }
    const onMessage = (event: MessageEvent) => {
      if (event.origin !== workerOrigin || event.source !== frame.contentWindow) return
      const data = event.data as {type?: unknown; iceServers?: unknown; error?: unknown} | null
      if (data?.type !== MESSAGE_TYPE) return
      if (data.error) console.warn('TURN unavailable:', data.error)
      finish(parseIceServers(data.iceServers))
    }
    const timer = setTimeout(() => finish([]), CHALLENGE_TIMEOUT_MS)
    addEventListener('message', onMessage)
    document.body.append(frame)
  })
}

/** Gets TURN servers for this session. Resolves to none on any failure, so chat still tries direct. */
export async function fetchTurnServers(workerUrl = import.meta.env.VITE_TURN_URL): Promise<TurnServerConfig[]> {
  if (!workerUrl) return []
  const cached = readCache(Date.now())
  if (cached.length > 0) return cached
  const iceServers = await requestFromWorker(workerUrl)
  if (iceServers.length > 0) writeCache(Date.now(), iceServers)
  return iceServers
}
