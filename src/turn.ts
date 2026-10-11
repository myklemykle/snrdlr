import type {TurnServerConfig} from 'trystero/nostr'

const FETCH_TIMEOUT_MS = 4000

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

/** Fetches TURN servers for this session. Resolves to none on any failure, so chat still tries direct. */
export async function fetchTurnServers(url = import.meta.env.VITE_TURN_URL): Promise<TurnServerConfig[]> {
  if (!url) return []
  try {
    const response = await fetch(url, {signal: AbortSignal.timeout(FETCH_TIMEOUT_MS)})
    if (!response.ok) return []
    const {iceServers} = (await response.json()) as {iceServers?: unknown}
    return Array.isArray(iceServers) ? iceServers.filter(isIceServer) : []
  } catch {
    return []
  }
}
