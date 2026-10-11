import {joinRoom, selfId} from 'trystero/nostr'
import type {ChatKeys} from './keys'

const APP_ID = 'snrdlr-v1'
const MAX_TEXT_LENGTH = 4000

export type ChatHandlers = {
  onText: (text: string, peerId: string) => void
  onPeersChange: (peerIds: string[]) => void
  onError: (message: string) => void
}

export type Chat = {
  selfId: string
  send: (text: string) => Promise<void>
  leave: () => Promise<void>
}

export function joinChat(keys: ChatKeys, handlers: ChatHandlers): Chat {
  const peers = new Set<string>()
  const room = joinRoom({appId: APP_ID, password: keys.sdpPassword}, keys.roomId, {
    onJoinError: ({error}) => handlers.onError(error)
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
    leave: () => room.leave()
  }
}
