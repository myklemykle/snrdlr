// The temporary room where an invite token is exchanged for membership of a chat.
import {joinRoom, type TurnServerConfig} from 'trystero/nostr'
import type {Invite} from './invite'
import {deriveInviteKeys} from './keys'
import {APP_ID, leaveWhenSettled, relayConfig} from './transport'

const REQUEST_TIMEOUT_MS = 15_000
const MAX_REQUEST_BYTES = 1024
const MAX_GRANT_BYTES = 64 * 1024

const toBytes = (data: unknown) => (data instanceof Uint8Array ? data : new Uint8Array(data as ArrayBuffer))

function joinInviteRoom(invite: Invite, turnServers: TurnServerConfig[]) {
  const keys = deriveInviteKeys(invite.token)
  return joinRoom({appId: APP_ID, password: keys.sdpPassword, turnConfig: turnServers, relayConfig}, keys.roomId)
}

/**
 * Waits in the invite's room and answers everyone who arrives with whatever `respond` makes of their
 * request, until closed. `respond` throws to turn a request down.
 */
export function hostInvite(
  invite: Invite,
  respond: (request: Uint8Array) => Uint8Array,
  turnServers: TurnServerConfig[]
): {close: () => void} {
  const joinedAt = Date.now()
  const room = joinInviteRoom(invite, turnServers)
  // Checked on every request, so a closed invite gives out nothing even if the room itself lingers.
  let open = true
  room.makeAction<Uint8Array, Uint8Array>('join', {
    kind: 'request',
    onReceive: ({byteLength}) => byteLength <= MAX_REQUEST_BYTES,
    onRequest: request => {
      if (!open) throw new Error('invite closed')
      return respond(toBytes(request))
    }
  })
  return {
    close: () => {
      open = false
      void leaveWhenSettled(room, joinedAt)
    }
  }
}

/**
 * Joins the invite's room and sends `request` to whoever is there. Resolves with what `accept` makes of
 * the first answer it does not throw on. Rejects if no acceptable answer comes before the timeout, which
 * is what a closed or expired invite looks like.
 */
export function redeemInvite<T>(
  invite: Invite,
  request: Uint8Array,
  accept: (sealedGrant: Uint8Array) => T,
  turnServers: TurnServerConfig[],
  timeoutMs: number
): Promise<T> {
  return new Promise((resolve, reject) => {
    const joinedAt = Date.now()
    const room = joinInviteRoom(invite, turnServers)
    const join = room.makeAction<Uint8Array, Uint8Array>('join', {
      kind: 'request',
      onReceive: ({byteLength}) => byteLength <= MAX_GRANT_BYTES
    })
    const finish = (settle: () => void) => {
      clearTimeout(timer)
      void leaveWhenSettled(room, joinedAt)
      settle()
    }
    const timer = setTimeout(() => finish(() => reject(new Error('invite is not active'))), timeoutMs)

    // Other people joining through the same code are in this room too; only the inviter can answer validly.
    room.onPeerJoin = peerId => {
      join
        .request(request, {target: peerId, timeoutMs: REQUEST_TIMEOUT_MS})
        .then(sealed => {
          const accepted = accept(toBytes(sealed))
          finish(() => resolve(accepted))
        })
        .catch(() => {})
    }
  })
}
