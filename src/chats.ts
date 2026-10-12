// Making, joining and guarding chats: what a chat record holds, and the invite exchange that creates one.
import {concatBytes} from './bytes'
import type {Identity} from './identity'
import {openGrant, openJoinRequest, sealGrant, type Grant, type Invite} from './invite'
import {deriveChatKeys, generateGroupSecret} from './keys'
import {checkProof, issueCert, makeProof, verifyChain, type Policy} from './membership'
import {uniqueChatName} from './names'
import type {ChatRecord} from './store'

/** How the transport checks, on each connection, that the other side belongs in the chat. */
export type ChatAuth = {
  prove: (binding: Uint8Array) => Uint8Array
  /** Returns the peer's member ID, or null to refuse them. */
  verify: (proof: Uint8Array, binding: Uint8Array) => string | null
}

export function policyOf(chat: ChatRecord): Policy {
  if (chat.kind === 'dm') return {kind: 'dm', members: [chat.context.slice(0, 32), chat.context.slice(32, 64)]}
  return {kind: 'group', founder: chat.context}
}

export const chatKeys = (chat: ChatRecord) => deriveChatKeys(chat.secret, chat.context)

export function authFor(chat: ChatRecord, identity: Identity): ChatAuth {
  const policy = policyOf(chat)
  return {
    prove: binding => makeProof(chat.id, identity, chat.chain, binding),
    verify: (proof, binding) => checkProof(chat.id, policy, proof, binding)
  }
}

/** A new group, founded by us. */
export function newGroupChat(identity: Identity, name: string, takenNames: string[], now: number): ChatRecord {
  const secret = generateGroupSecret()
  const context = identity.signPublic
  return {
    id: deriveChatKeys(secret, context).roomId,
    kind: 'group',
    secret,
    context,
    chain: [],
    name: uniqueChatName(name, takenNames),
    createdAt: now
  }
}

/**
 * The inviter's answer to someone redeeming an invite: checks the request is from the key it names,
 * admits that key with a certificate, and returns the signed grant plus the certificate to post to the log.
 */
export function admit(
  chat: ChatRecord,
  identity: Identity,
  invite: Invite,
  request: Uint8Array,
  now: number
): {sealedGrant: Uint8Array; cert: Uint8Array} {
  if (chat.kind !== 'group') throw new Error('only groups admit members by invite')
  const joiner = openJoinRequest(invite, request)
  const cert = issueCert(chat.id, identity, joiner, now)
  const grant: Grant = {secret: chat.secret, name: chat.name, founder: chat.context, chain: [...chat.chain, cert]}
  return {sealedGrant: sealGrant(identity, invite, grant), cert}
}

/**
 * The joiner's side: opens the inviter's grant and checks that it really admits us to the chat it
 * describes. Throws otherwise, so a bad grant is treated like no answer at all.
 */
export function chatFromGrant(invite: Invite, sealedGrant: Uint8Array, identity: Identity, now: number): ChatRecord {
  const grant = openGrant(invite, sealedGrant)
  const id = deriveChatKeys(grant.secret, grant.founder).roomId
  if (!verifyChain(id, grant.founder, grant.chain, identity.signPublic)) throw new Error('grant does not admit us')
  return {id, kind: 'group', secret: grant.secret, context: grant.founder, chain: grant.chain, name: grant.name, createdAt: now}
}

/** Both members' signing keys in a fixed order, so each side derives the same direct chat. */
export function dmContext(a: Uint8Array, b: Uint8Array): Uint8Array {
  for (let i = 0; i < 32; i++) if (a[i] !== b[i]) return a[i] < b[i] ? concatBytes(a, b) : concatBytes(b, a)
  throw new Error('a direct chat needs two different people')
}
