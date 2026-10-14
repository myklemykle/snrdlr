// A person's card: the optional extras of their profile (icon, photo, contact, colour) as they have
// chosen to show them in one chat. Their name travels separately, in their "joined" message.
import {bytesEqual} from './bytes'
import {writtenAfter, type CardContent} from './envelope'
import type {MessageRecord} from './store'

/** Whether a card shows anything at all. An empty one is how a person takes theirs back. */
export const cardIsEmpty = (card: CardContent) => !card.icon && !card.avatar && !card.photo && !card.contact && !card.color

export function sameCard(a: CardContent, b: CardContent): boolean {
  return (
    (a.icon ?? '') === (b.icon ?? '') &&
    (a.color ?? '') === (b.color ?? '') &&
    (a.contact?.kind ?? '') === (b.contact?.kind ?? '') &&
    (a.contact?.value ?? '') === (b.contact?.value ?? '') &&
    (a.photo?.hash ?? '') === (b.photo?.hash ?? '') &&
    bytesEqual(a.avatar ?? new Uint8Array(0), b.avatar ?? new Uint8Array(0))
  )
}

/** Each member's current card: the latest they posted, on any of their devices. Empty ones are left out. */
export function latestCards(messages: MessageRecord[]): Map<string, CardContent> {
  const latest = new Map<string, MessageRecord & {content: CardContent}>()
  for (const message of messages) {
    if (message.content.type !== 'card') continue
    const earlier = latest.get(message.author)
    if (!earlier || writtenAfter(message, earlier)) latest.set(message.author, message as MessageRecord & {content: CardContent})
  }
  return new Map([...latest].filter(([, {content}]) => !cardIsEmpty(content)).map(([author, {content}]) => [author, content]))
}

/** The colours offered for tinting messages. */
export const COLORS: [name: string, value: string][] = [
  ['Red', '#d1453b'],
  ['Orange', '#e07a1f'],
  ['Yellow', '#c9a100'],
  ['Green', '#2f9e5b'],
  ['Teal', '#1f9aa8'],
  ['Blue', '#3b74d9'],
  ['Purple', '#8a56d6'],
  ['Pink', '#d6539a']
]

export const CONTACT_KINDS = ['email', 'phone', 'instagram', 'other'] as const
export type ContactKind = (typeof CONTACT_KINDS)[number]
export const CONTACT_LABELS: Record<ContactKind, string> = {email: 'Email', phone: 'Phone', instagram: 'Instagram', other: 'Other'}

/** A link that opens the contact, where its kind has one. Built only from the value's safe characters. */
export function contactLink(contact: {kind: ContactKind; value: string}): string | null {
  const value = contact.value.trim()
  if (contact.kind === 'email' && /^[^\s@<>"']+@[^\s@<>"']+$/.test(value)) return `mailto:${encodeURIComponent(value).replace('%40', '@')}`
  if (contact.kind === 'phone' && /^\+?[\d\s().-]{3,}$/.test(value)) return `tel:${value.replace(/[^\d+]/g, '')}`
  if (contact.kind === 'instagram' && /^@?[\w.]{1,30}$/.test(value)) return `https://instagram.com/${value.replace(/^@/, '')}`
  return null
}

/** A colour for someone who has not chosen one, so that two people of the same name still look different. */
export function fallbackHue(memberId: string): number {
  return parseInt(memberId.slice(0, 6), 16) % 360
}
