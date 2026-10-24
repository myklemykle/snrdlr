// A developer-mode check of one chat: what this device holds from each person, and what the relay
// holds for the chat that this device lacks. It reports counts and dates only, never what was said,
// so the report can be copied and passed on to whoever is looking into a problem.
import {chatKeys} from './chats'
import {importMsgKey, openEnvelope, streamOf, type Message} from './envelope'
import type {Identity} from './identity'
import type {OpenMailbox} from './mailbox'
import {collect} from './remote-invite'
import type {Store, ChatRecord} from './store'
import {openAsMember} from './store-seal'

const RELAY_TIMEOUT_MS = 20_000
const SHOWN = new Set(['text', 'image', 'audio'])

type Stream = {author: string; device: string; seqs: Set<number>; shown: number; first: number; last: number}

// Times are in UTC, so reports from devices in different places line up.
const day = (ms: number) => (Number.isFinite(ms) ? new Date(ms).toISOString().slice(0, 16).replace('T', ' ') : '-')

/** Each stream's messages: how many, the highest number, how many numbers below it are missing. */
function streamsOf(messages: Message[]): Map<string, Stream> {
  const streams = new Map<string, Stream>()
  for (const message of messages) {
    const key = streamOf(message)
    const stream = streams.get(key) ?? {author: message.author, device: message.device, seqs: new Set(), shown: 0, first: Infinity, last: -Infinity}
    stream.seqs.add(message.seq)
    if (SHOWN.has(message.content.type)) stream.shown++
    stream.first = Math.min(stream.first, message.sentAt)
    stream.last = Math.max(stream.last, message.sentAt)
    streams.set(key, stream)
  }
  return streams
}

const describe = (stream: Stream) => {
  const top = Math.max(...stream.seqs)
  const missing = top - stream.seqs.size
  return `${stream.seqs.size} (${stream.shown} shown), up to #${top}${missing ? `, ${missing} missing below` : ''}, ${day(stream.first)} to ${day(stream.last)}`
}

/** A plain-text report on one chat, for developer mode. */
export async function diagnoseChat(shown: ChatRecord, identity: Identity, store: Store, open: OpenMailbox): Promise<string> {
  // The record as stored now, which says when the relay was last collected from.
  const chat = (await store.getChat(shown.id)) ?? shown
  const held = await store.listMessages(chat.id)
  const names = new Map<string, string>()
  for (const {author, content} of held) if (content.type === 'profile') names.set(author, content.name)
  const who = (stream: Stream) =>
    `${stream.author === identity.id ? 'me' : (names.get(stream.author) ?? 'unknown')} ${stream.author.slice(0, 6)}${stream.device ? `.${stream.device.slice(0, 4)}` : ''}${stream.author === identity.id && stream.device === identity.device ? ' (this device)' : ''}`

  const lines = [
    `Chat ${chat.id.slice(0, 8)} (${chat.kind}), here since ${day(chat.createdAt)}${chat.historyBefore ? ', from another of my devices' : ''}`,
    `Checked ${day(Date.now())} UTC; last collected from the relay ${chat.collectedAt ? day(chat.collectedAt) : 'never'}`,
    '',
    `On this device: ${held.length} messages`
  ]
  const here = streamsOf(held)
  for (const stream of here.values()) lines.push(`  ${who(stream)}: ${describe(stream)}`)

  const stored = await collect(open, chatKeys(chat).storeTopic, RELAY_TIMEOUT_MS)
  lines.push('')
  if (!stored) {
    lines.push('The relay did not answer.')
    return lines.join('\n')
  }
  const context = {chatId: chat.id, msgKey: await importMsgKey(chatKeys(chat).msgKey)}
  const opened: Message[] = []
  let locked = 0
  let broken = 0
  for (const sealed of stored) {
    const envelope = await openAsMember(chat.id, sealed, identity)
    if (!envelope) {
      locked++
      continue
    }
    const message = await openEnvelope(context, envelope).catch(() => null)
    if (message) opened.push(message)
    else broken++
  }
  const there = streamsOf(opened)
  // The same message can be left more than once, so the different ones are counted too.
  const different = [...there.values()].reduce((sum, stream) => sum + stream.seqs.size, 0)
  lines.push(`On the relay: ${stored.length} stored, ${opened.length} opened here (${different} different), ${locked} not locked to me, ${broken} not genuine`)
  for (const [key, stream] of there) {
    const ours = here.get(key)?.seqs
    const lacking = [...stream.seqs].filter(seq => !ours?.has(seq)).length
    lines.push(`  ${who(stream)}: ${describe(stream)}${lacking ? `; ${lacking} not on this device` : ''}`)
  }
  return lines.join('\n')
}
