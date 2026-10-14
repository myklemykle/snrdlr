// A minimal in-memory Nostr relay for local testing, so test runs don't lean on public relays.
// It forwards live events to matching subscriptions, with no signature checks and no limits. Like
// our real relay (worker-relay/), it keeps one kind of event, the sealed chat message, and hands
// those over to whoever asks for their topic later; everything else is forgotten once passed on.
// Do not expose it to a network.
import {WebSocketServer} from 'ws'

const port = Number(process.env.RELAY_PORT ?? 7777)
const server = new WebSocketServer({host: '127.0.0.1', port})

/** @type {Map<import('ws').WebSocket, Map<string, object[]>>} */
const subscriptions = new Map()

const STORED_KIND = 7467
/** @type {Map<string, object>} */
const stored = new Map()

const matches = (filter, event) =>
  Object.entries(filter).every(([key, wanted]) => {
    if (key === 'kinds') return wanted.includes(event.kind)
    if (key === 'since') return event.created_at >= wanted
    if (key === 'until') return event.created_at <= wanted
    if (key === 'ids') return wanted.includes(event.id)
    if (key === 'authors') return wanted.includes(event.pubkey)
    if (key.startsWith('#')) return event.tags.some(tag => tag[0] === key.slice(1) && wanted.includes(tag[1]))
    return true
  })

server.on('connection', socket => {
  const subs = new Map()
  subscriptions.set(socket, subs)
  socket.on('close', () => subscriptions.delete(socket))
  socket.on('message', raw => {
    let message
    try {
      message = JSON.parse(raw.toString())
    } catch {
      return socket.send(JSON.stringify(['NOTICE', 'invalid JSON']))
    }
    const [type, ...rest] = message
    if (type === 'REQ') {
      const [subId, ...filters] = rest
      subs.set(subId, filters)
      const wanted = filters.filter(filter => Array.isArray(filter.kinds) && filter.kinds.includes(STORED_KIND))
      for (const event of stored.values()) {
        if (wanted.some(filter => matches(filter, event))) socket.send(JSON.stringify(['EVENT', subId, event]))
      }
      socket.send(JSON.stringify(['EOSE', subId]))
    } else if (type === 'CLOSE') {
      subs.delete(rest[0])
    } else if (type === 'EVENT') {
      const [event] = rest
      if (!event || !Array.isArray(event.tags)) return socket.send(JSON.stringify(['NOTICE', 'invalid event']))
      if (event.kind === STORED_KIND) {
        if (stored.has(event.id)) return socket.send(JSON.stringify(['OK', event.id, true, 'duplicate: already have this event']))
        stored.set(event.id, event)
      }
      socket.send(JSON.stringify(['OK', event.id, true, '']))
      for (const [peer, peerSubs] of subscriptions) {
        for (const [subId, filters] of peerSubs) {
          if (filters.some(filter => matches(filter, event))) peer.send(JSON.stringify(['EVENT', subId, event]))
        }
      }
    }
  })
})

server.on('listening', () => console.log(`local Nostr relay listening on ws://localhost:${port}`))
