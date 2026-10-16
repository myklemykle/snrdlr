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

/** How light a colour looks (WCAG relative luminance), from 0 for black to 1 for white. */
function luminance([r, g, b]: number[]): number {
  const linear = (c: number) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4)
  return 0.2126 * linear(r / 255) + 0.7152 * linear(g / 255) + 0.0722 * linear(b / 255)
}

/**
 * The colour, darkened only as far as it takes for white words on it to read easily (a contrast of at
 * least 4.5 to 1, the usual standard for text): for one's own messages in one's own colour.
 */
export function behindWhiteText(hex: string): string {
  const rgb = [1, 3, 5].map(at => parseInt(hex.slice(at, at + 2), 16))
  if (rgb.some(Number.isNaN)) return hex
  let shade = rgb
  for (let step = 0; step < 40 && 1.05 / (luminance(shade) + 0.05) < 4.5; step++) shade = shade.map(c => Math.round(c * 0.95))
  return `#${shade.map(c => c.toString(16).padStart(2, '0')).join('')}`
}

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
