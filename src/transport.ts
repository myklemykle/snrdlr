import {joinRoom, selfId, type TurnServerConfig} from 'trystero/nostr'
import type {ChatKeys} from './keys'
import {routeFromStats, type Route} from './route'

const APP_ID = 'snrdlr-v1'
const MAX_TEXT_LENGTH = 4000

// Set for local testing against scripts/local-relay.mjs; unset, Trystero picks from its public relay list.
const relayUrls = import.meta.env.VITE_NOSTR_RELAYS?.split(',').map(url => url.trim()).filter(Boolean)
const relayConfig = relayUrls?.length ? {urls: relayUrls} : undefined

export type ChatHandlers = {
  onText: (text: string, peerId: string) => void
  onPeersChange: (peerIds: string[]) => void
  onError: (message: string) => void
}

export type Chat = {
  selfId: string
  send: (text: string) => Promise<void>
  /** The route currently in use to each connected peer whose route is known. */
  routes: () => Promise<Route[]>
  leave: () => Promise<void>
}

export function joinChat(keys: ChatKeys, handlers: ChatHandlers, turnServers: TurnServerConfig[] = []): Chat {
  const peers = new Set<string>()
  const room = joinRoom({appId: APP_ID, password: keys.sdpPassword, turnConfig: turnServers, relayConfig}, keys.roomId, {
    // Trystero's error text is aimed at developers; keep it in the console.
    onJoinError: ({error}) => {
      console.warn(error)
      handlers.onError("Couldn't connect to the other device over this network.")
    }
  })

  const text = room.makeAction<string>('text', {
    onMessage: (data, {peerId}) => {
      if (typeof data === 'string' && data.length <= MAX_TEXT_LENGTH) handlers.onText(data, peerId)
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
    selfId,
    send: message => text.send(message.slice(0, MAX_TEXT_LENGTH)),
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
