// The temporary room where an invite token is exchanged for a chat's secret.
import {joinRoom, type TurnServerConfig} from 'trystero/nostr'
import {openGrant, type Grant, type Invite} from './invite'
import {deriveInviteKeys} from './keys'
import {APP_ID, leaveWhenSettled, relayConfig} from './transport'

const REQUEST_TIMEOUT_MS = 15_000
const MAX_GRANT_BYTES = 1024

function joinInviteRoom(invite: Invite, turnServers: TurnServerConfig[]) {
  const keys = deriveInviteKeys(invite.token)
  return joinRoom({appId: APP_ID, password: keys.sdpPassword, turnConfig: turnServers, relayConfig}, keys.roomId)
}

/** Waits in the invite's room and hands the sealed grant to everyone who arrives, until closed. */
export function hostInvite(invite: Invite, sealedGrant: Uint8Array, turnServers: TurnServerConfig[]): {close: () => void} {
  const joinedAt = Date.now()
  const room = joinInviteRoom(invite, turnServers)
  // Checked on every request, so a closed invite gives out nothing even if the room itself lingers.
  let open = true
  room.makeAction<null, Uint8Array>('join', {
    kind: 'request',
    onRequest: () => {
      if (!open) throw new Error('invite closed')
      return sealedGrant
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
 * Joins the invite's room and asks whoever is there for the grant. Rejects if nobody answers with one
 * signed by the inviter before the timeout, which is what a closed or expired invite looks like.
 */
export function redeemInvite(invite: Invite, turnServers: TurnServerConfig[], timeoutMs: number): Promise<Grant> {
  return new Promise((resolve, reject) => {
    const joinedAt = Date.now()
    const room = joinInviteRoom(invite, turnServers)
    const join = room.makeAction<null, Uint8Array>('join', {
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
        .request(null, {target: peerId, timeoutMs: REQUEST_TIMEOUT_MS})
        .then(sealed => {
          const grant = openGrant(invite, sealed instanceof Uint8Array ? sealed : new Uint8Array(sealed as ArrayBuffer))
          finish(() => resolve(grant))
        })
        .catch(() => {})
    }
  })
}
