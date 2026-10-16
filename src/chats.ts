// Making, joining and guarding chats: what a chat record holds, and the invite exchange that creates one.
import {x25519} from '@noble/curves/ed25519.js'
import {hkdf} from '@noble/hashes/hkdf.js'
import {sha256} from '@noble/hashes/sha2.js'
import {bytesEqual, concatBytes, utf8} from './bytes'
import type {Content} from './envelope'
import type {Identity} from './identity'
import {openGrant, openJoinRequest, sealGrant, type Grant, type Invite} from './invite'
import {deriveChatKeys, generateGroupSecret} from './keys'
import {checkProof, issueCert, makeProof, verifyChain, type Policy} from './membership'
import {uniqueChatName} from './names'

export const DEFAULT_DM_NAME = 'Direct chat'
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
  const grant: Grant = {kind: 'group', secret: chat.secret, name: chat.name, founder: chat.context, chain: [...chat.chain, cert]}
  return {sealedGrant: sealGrant(identity, invite, grant), cert}
}

/**
 * The joiner's side: opens the inviter's grant and checks that it really admits us to the chat it
 * describes. Throws otherwise, so a bad grant is treated like no answer at all.
 */
export function chatFromGrant(invite: Invite, sealedGrant: Uint8Array, identity: Identity, now: number): ChatRecord {
  const grant = openGrant(invite, sealedGrant)
  if (grant.kind === 'dm') return directChat(identity, {signPublic: invite.inviter, dhPublic: grant.dhPublic}, grant.name, now)
  const id = deriveChatKeys(grant.secret, grant.founder).roomId
  if (!verifyChain(id, grant.founder, grant.chain, identity.signPublic)) throw new Error('grant does not admit us')
  return {id, kind: 'group', secret: grant.secret, context: grant.founder, chain: grant.chain, name: grant.name, createdAt: now}
}

/** Both members' signing keys in a fixed order, so each side derives the same direct chat. */
export function dmContext(a: Uint8Array, b: Uint8Array): Uint8Array {
  for (let i = 0; i < 32; i++) if (a[i] !== b[i]) return a[i] < b[i] ? concatBytes(a, b) : concatBytes(b, a)
  throw new Error('a direct chat needs two different people')
}

/**
 * A direct chat between us and one other person. Its secret comes from a key agreement between the
 * two identities, so each side arrives at the same chat independently, and nobody can be added to it.
 */
export function directChat(
  identity: Identity,
  peer: {signPublic: Uint8Array; dhPublic: Uint8Array},
  name: string,
  now: number
): ChatRecord {
  const context = dmContext(identity.signPublic, peer.signPublic)
  const shared = x25519.getSharedSecret(identity.dhSecret, peer.dhPublic)
  const secret = hkdf(sha256, shared, context, utf8('snrdlr/v1/dm'), 32)
  return {id: deriveChatKeys(secret, context).roomId, kind: 'dm', secret, context, chain: [], peer, name, createdAt: now}
}

/**
 * The answer of someone showing a "chat with me" code: makes the direct chat on our side and tells
 * the scanner our X25519 key so they can make the same one.
 */
export function pairDirect(
  identity: Identity,
  invite: Invite,
  request: Uint8Array,
  takenNames: string[],
  now: number
): {chat: ChatRecord; sealedGrant: Uint8Array} {
  const joiner = openJoinRequest(invite, request)
  const chat = directChat(identity, joiner, uniqueChatName(joiner.name || DEFAULT_DM_NAME, takenNames), now)
  return {chat, sealedGrant: sealGrant(identity, invite, {kind: 'dm', dhPublic: identity.dhPublic, name: identity.name})}
}

/**
 * Answers whoever scans one showing of a "chat with me" code. The first person gets a direct chat, and
 * the chat is returned so it can be kept. The same person asking again, because the answer never reached
 * them, gets the same answer and no new chat. Anyone else is turned away: one showing makes one chat.
 */
export function directAnswerer(identity: Identity, invite: Invite) {
  let answered: {joiner: Uint8Array; sealedGrant: Uint8Array} | null = null
  return (request: Uint8Array, takenNames: string[], now: number): {chat: ChatRecord | null; sealedGrant: Uint8Array} => {
    if (answered) {
      if (bytesEqual(openJoinRequest(invite, request).signPublic, answered.joiner)) return {chat: null, sealedGrant: answered.sealedGrant}
      throw new Error('code already used')
    }
    const {chat, sealedGrant} = pairDirect(identity, invite, request, takenNames, now)
    answered = {joiner: openJoinRequest(invite, request).signPublic, sealedGrant}
    return {chat, sealedGrant}
  }
}

type GroupInvite = Extract<Content, {type: 'group-invite'}>

/**
 * "Add someone" in a direct chat: founds a new group that already includes the other person. Returns
 * the group, and the message to post in the direct chat that lets them into it.
 */
export function groupFromDirect(
  identity: Identity,
  direct: ChatRecord,
  name: string,
  takenNames: string[],
  now: number
): {chat: ChatRecord; invite: GroupInvite} {
  if (direct.kind !== 'dm' || !direct.peer) throw new Error('not a direct chat')
  const chat = newGroupChat(identity, name, takenNames, now)
  const cert = issueCert(chat.id, identity, direct.peer, now)
  return {chat, invite: {type: 'group-invite', secret: chat.secret, name: chat.name, founder: chat.context, chain: [cert]}}
}

/** Opens a group invite received in a direct chat. Throws unless its sender founded the group and it admits us. */
export function chatFromGroupInvite(invite: GroupInvite, sender: Uint8Array, identity: Identity, now: number): ChatRecord {
  if (!bytesEqual(invite.founder, sender)) throw new Error('group invite is not from the group founder')
  const id = deriveChatKeys(invite.secret, invite.founder).roomId
  if (!verifyChain(id, invite.founder, invite.chain, identity.signPublic)) throw new Error('group invite does not admit us')
  return {id, kind: 'group', secret: invite.secret, context: invite.founder, chain: invite.chain, name: invite.name, createdAt: now}
}
