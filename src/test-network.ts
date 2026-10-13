// Test support only; nothing in the app imports this.
import type {Wire, WireHandlers} from './session'

/** An in-memory stand-in for the WebRTC room: everything sent reaches every other connected member. */
export function makeNetwork() {
  const members = new Map<string, WireHandlers>()
  const dead = new Set<string>()
  const announce = () => members.forEach((handlers, id) => handlers.onPeersChange([...members.keys()].filter(peer => peer !== id)))
  const deliver = (from: string, target: string | undefined, act: (handlers: WireHandlers) => void) => {
    if (dead.has(from)) return
    members.forEach((handlers, id) => id !== from && !dead.has(id) && (!target || target === id) && act(handlers))
  }
  return {
    /** Every envelope put on the wire, with who sent it and to whom. */
    sent: [] as {from: string; to?: string; envelope: Uint8Array}[],
    /** Every answer to a request for a file: who sent it to whom, and whether they had it. */
    files: [] as {from: string; to: string; hash: string; sent: boolean}[],
    joins: 0,
    /** Who is in the room right now. */
    present: () => [...members.keys()],
    /** Delivers raw bytes to one member, as a peer in the room could. */
    inject: (to: string, envelope: Uint8Array) => members.get(to)!.onEnvelope(envelope, 'injected'),
    /** Silently breaks a member's connections, as a phone does when the app is in the background. */
    kill: (peerId: string) => dead.add(peerId),
    /** Reports a failed connection attempt to one member, as the transport does. */
    fail: (peerId: string) => members.get(peerId)!.onError('could not connect'),
    connect(peerId: string) {
      return (_keys: unknown, handlers: WireHandlers): Wire => {
        this.joins++
        dead.delete(peerId)
        members.set(peerId, handlers)
        queueMicrotask(announce)
        return {
          send: async (envelope, target) => {
            this.sent.push({from: peerId, to: target, envelope})
            deliver(peerId, target, peer => peer.onEnvelope(envelope, peerId))
          },
          sendSync: async (have, target) => deliver(peerId, target, peer => peer.onSync(have, peerId)),
          ping: async target => {
            if (dead.has(peerId) || dead.has(target) || !members.has(target)) throw new Error('no answer')
          },
          requestFile: async (hash, target) => deliver(peerId, target, peer => peer.onFileWanted(hash, peerId)),
          sendFile: async (hash, data, target) => {
            this.files.push({from: peerId, to: target, hash, sent: data !== null})
            deliver(peerId, target, peer => {
              if (data === null || peer.expectsFile(hash, data.length, peerId)) peer.onFile(hash, data, peerId)
            })
          },
          routes: async () => [],
          leave: async () => {
            // A dead connection cannot say goodbye: the others still list this member until it rejoins.
            if (dead.has(peerId)) return
            if (members.get(peerId) === handlers) members.delete(peerId)
            announce()
          }
        }
      }
    }
  }
}
