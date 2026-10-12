import {joinRoom, type TurnServerConfig} from 'trystero/nostr'
import {toHex, utf8} from './bytes'
import type {ChatAuth} from './chats'
import {MAX_ENVELOPE_BYTES} from './envelope'
import type {ChatKeys} from './keys'
import {routeFromStats} from './route'
import type {VersionVector, Wire, WireHandlers} from './session'

export const APP_ID = 'snrdlr-v2'
const MAX_SYNC_BYTES = 128 * 1024
const MAX_PROOF_BYTES = 64 * 1024
const PING_TIMEOUT_MS = 4000
const AUTH_TIMEOUT_MS = 10_000

// Set for local testing against scripts/local-relay.mjs; unset, Trystero picks from its public relay list.
const relayUrls = import.meta.env.VITE_NOSTR_RELAYS?.split(',').map(url => url.trim()).filter(Boolean)
export const relayConfig = relayUrls?.length ? {urls: relayUrls} : undefined

// Trystero does not fully leave a room that is left within about a second of joining it: the room keeps
// answering newcomers. Holding the leave back until the join has settled avoids that.
const MIN_ROOM_LIFETIME_MS = 2500

export function leaveWhenSettled(room: {leave: () => Promise<void>}, joinedAt: number): Promise<void> {
  const wait = Math.max(0, joinedAt + MIN_ROOM_LIFETIME_MS - Date.now())
  return new Promise(resolve => setTimeout(() => resolve(room.leave()), wait))
}

/** The certificate fingerprint a WebRTC connection's encryption is tied to, as written in its SDP. */
export function dtlsFingerprint(sdp: string | undefined): string | null {
  const match = sdp?.match(/^a=fingerprint:(\S+)[ \t]+([0-9A-Fa-f:]+)/m)
  return match ? `${match[1].toLowerCase()} ${match[2].toUpperCase()}` : null
}

/**
 * What a membership proof is signed over: both sides' fresh nonces and both ends' encryption
 * fingerprints. Someone relaying between two members has their own fingerprints, so cannot reuse it.
 */
export function proofBinding(prover: {nonce: string; fingerprint: string}, verifier: {nonce: string; fingerprint: string}): Uint8Array {
  return utf8([prover.nonce, verifier.nonce, prover.fingerprint, verifier.fingerprint].join('|'))
}

type PeerState = {
  ourNonce: string
  theirNonce?: string
  /** A proof that arrived before the nonce it answers. */
  earlyProof?: Uint8Array
  proofSent: boolean
  settled: boolean
  timer: ReturnType<typeof setTimeout>
}

/**
 * Joins a chat's room. Peers only count, and only exchange messages with us, once they have proved
 * they are members; anyone else who finds the room is ignored.
 */
export function joinChat(keys: ChatKeys, handlers: WireHandlers, turnServers: TurnServerConfig[], auth: ChatAuth): Wire {
  const joined = new Set<string>()
  const members = new Set<string>()
  const states = new Map<string, PeerState>()
  const room = joinRoom({appId: APP_ID, password: keys.sdpPassword, turnConfig: turnServers, relayConfig}, keys.roomId, {
    // Trystero's error text is aimed at developers; keep it in the console.
    onJoinError: ({error}) => {
      console.warn(error)
      handlers.onError("Couldn't connect to the other device over this network.")
    }
  })

  const hellos = room.makeAction<string>('auth-hello', {
    onMessage: (nonce, {peerId}) => {
      if (typeof nonce !== 'string' || !/^[0-9a-f]{32}$/.test(nonce)) return
      const state = stateFor(peerId)
      if (state.theirNonce) return
      state.theirNonce = nonce
      prove(peerId)
      if (state.earlyProof) check(peerId, state.earlyProof)
    }
  })
  const proofs = room.makeAction<Uint8Array>('auth-proof', {
    onReceive: ({byteLength}) => byteLength <= MAX_PROOF_BYTES,
    onMessage: (data: unknown, {peerId}) => {
      const proof = data instanceof ArrayBuffer ? new Uint8Array(data) : data instanceof Uint8Array ? data : null
      if (proof) check(peerId, proof)
    }
  })
  const envelopes = room.makeAction<Uint8Array>('env', {
    onReceive: ({byteLength}) => byteLength <= MAX_ENVELOPE_BYTES,
    onMessage: (data: unknown, {peerId}) => {
      if (!members.has(peerId)) return
      if (data instanceof ArrayBuffer) handlers.onEnvelope(new Uint8Array(data), peerId)
      else if (data instanceof Uint8Array) handlers.onEnvelope(data, peerId)
    }
  })
  const syncs = room.makeAction<VersionVector>('sync', {
    onReceive: ({byteLength}) => byteLength <= MAX_SYNC_BYTES,
    onMessage: (data, {peerId}) => {
      if (members.has(peerId)) handlers.onSync(data, peerId)
    }
  })

  function stateFor(peerId: string): PeerState {
    let state = states.get(peerId)
    if (!state) {
      state = {
        ourNonce: toHex(crypto.getRandomValues(new Uint8Array(16))),
        proofSent: false,
        settled: false,
        timer: setTimeout(() => refuse(peerId, 'did not prove membership in time'), AUTH_TIMEOUT_MS)
      }
      states.set(peerId, state)
    }
    return state
  }

  function fingerprints(peerId: string): {ours: string; theirs: string} | null {
    const connection = room.getPeers()[peerId]
    const ours = dtlsFingerprint((connection?.currentLocalDescription ?? connection?.localDescription)?.sdp)
    const theirs = dtlsFingerprint((connection?.currentRemoteDescription ?? connection?.remoteDescription)?.sdp)
    return ours && theirs ? {ours, theirs} : null
  }

  function refuse(peerId: string, reason: string) {
    const state = states.get(peerId)
    if (!state || state.settled) return
    state.settled = true
    clearTimeout(state.timer)
    console.warn(`ignoring a peer in this chat's room: ${reason}`)
  }

  /** Sends our proof once we know the peer's nonce and the connection is up. */
  function prove(peerId: string) {
    const state = states.get(peerId)
    if (!state?.theirNonce || state.proofSent || !joined.has(peerId)) return
    const prints = fingerprints(peerId)
    if (!prints) return refuse(peerId, 'connection has no fingerprint to bind to')
    state.proofSent = true
    const binding = proofBinding({nonce: state.ourNonce, fingerprint: prints.ours}, {nonce: state.theirNonce, fingerprint: prints.theirs})
    void proofs.send(auth.prove(binding), {target: peerId}).catch(() => {})
  }

  function check(peerId: string, proof: Uint8Array) {
    const state = stateFor(peerId)
    if (state.settled) return
    if (!state.theirNonce || !joined.has(peerId)) {
      state.earlyProof = proof
      return
    }
    const prints = fingerprints(peerId)
    if (!prints) return refuse(peerId, 'connection has no fingerprint to bind to')
    const binding = proofBinding({nonce: state.theirNonce, fingerprint: prints.theirs}, {nonce: state.ourNonce, fingerprint: prints.ours})
    if (!auth.verify(proof, binding)) return refuse(peerId, 'not a member')
    state.settled = true
    clearTimeout(state.timer)
    members.add(peerId)
    handlers.onPeersChange([...members])
  }

  room.onPeerJoin = peerId => {
    joined.add(peerId)
    const state = stateFor(peerId)
    void hellos
      .send(state.ourNonce, {target: peerId})
      .then(() => {
        prove(peerId)
        if (state.earlyProof) check(peerId, state.earlyProof)
      })
      .catch(() => {})
  }
  room.onPeerLeave = peerId => {
    joined.delete(peerId)
    clearTimeout(states.get(peerId)?.timer)
    states.delete(peerId)
    if (members.delete(peerId)) handlers.onPeersChange([...members])
  }

  /** Everyone verified, or one verified peer; never anyone unverified. */
  const targets = (peerId?: string) => (peerId ? [peerId] : [...members]).filter(id => members.has(id))

  return {
    send: async (envelope, peerId) => {
      const to = targets(peerId)
      if (to.length > 0) await envelopes.send(envelope, {target: to})
    },
    sendSync: async (have, peerId) => {
      const to = targets(peerId)
      if (to.length > 0) await syncs.send(have, {target: to})
    },
    ping: peerId =>
      Promise.race([
        room.ping(peerId).then(() => undefined),
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error('ping timed out')), PING_TIMEOUT_MS))
      ]),
    routes: async () => {
      const connections = Object.entries(room.getPeers()).filter(([peerId]) => members.has(peerId))
      const routes = await Promise.all(
        connections.map(([, connection]) => connection.getStats().then(routeFromStats, () => null))
      )
      return routes.filter(route => route !== null)
    },
    leave: () => {
      states.forEach(state => clearTimeout(state.timer))
      return room.leave()
    }
  }
}
