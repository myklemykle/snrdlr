import {joinRoom, type TurnServerConfig} from 'trystero/nostr'
import {MAX_ENVELOPE_BYTES} from './envelope'
import type {ChatKeys} from './keys'
import {routeFromStats} from './route'
import type {Wire, WireHandlers} from './session'

const APP_ID = 'snrdlr-v1'

// Set for local testing against scripts/local-relay.mjs; unset, Trystero picks from its public relay list.
const relayUrls = import.meta.env.VITE_NOSTR_RELAYS?.split(',').map(url => url.trim()).filter(Boolean)
const relayConfig = relayUrls?.length ? {urls: relayUrls} : undefined

export function joinChat(keys: ChatKeys, handlers: WireHandlers, turnServers: TurnServerConfig[] = []): Wire {
  const peers = new Set<string>()
  const room = joinRoom({appId: APP_ID, password: keys.sdpPassword, turnConfig: turnServers, relayConfig}, keys.roomId, {
    // Trystero's error text is aimed at developers; keep it in the console.
    onJoinError: ({error}) => {
      console.warn(error)
      handlers.onError("Couldn't connect to the other device over this network.")
    }
  })

  const envelopes = room.makeAction<Uint8Array>('env', {
    onReceive: ({byteLength}) => byteLength <= MAX_ENVELOPE_BYTES,
    onMessage: (data: unknown, {peerId}) => {
      if (data instanceof ArrayBuffer) handlers.onEnvelope(new Uint8Array(data), peerId)
      else if (data instanceof Uint8Array) handlers.onEnvelope(data, peerId)
    }
  })

  room.onPeerJoin = peerId => {
    peers.add(peerId)
    handlers.onPeersChange([...peers])
  }
  room.onPeerLeave = peerId => {
    peers.delete(peerId)
    handlers.onPeersChange([...peers])
  }

  return {
    send: (envelope, peerId) => envelopes.send(envelope, peerId ? {target: peerId} : undefined),
    routes: async () => {
      const connections = Object.entries(room.getPeers()).filter(([peerId]) => peers.has(peerId))
      const routes = await Promise.all(
        connections.map(([, connection]) => connection.getStats().then(routeFromStats, () => null))
      )
      return routes.filter(route => route !== null)
    },
    leave: () => room.leave()
  }
}
