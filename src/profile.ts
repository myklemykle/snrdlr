// The person's own profile, beyond their name: kept on this device, and shown in a chat only as a card
// (see cards.ts) where they have chosen to show it.
import {fromHex, toHex} from './bytes'
import {cardIsEmpty, type ContactKind} from './cards'
import type {CardContent, PictureRef} from './envelope'
import type {CardToShare} from './session'
import type {Store} from './store'

const SETTING = 'snrdlr.profile'
/** Where the profile photo's encrypted file is kept: beside the chats' files, under a name no chat has. */
export const PROFILE_FILES = '~profile'

export type Profile = {
  icon?: string
  avatar?: Uint8Array
  photo?: PictureRef
  contact?: {kind: ContactKind; value: string}
  color?: string
  /** For each part, where it is shown: in every chat but those it is hidden in, or only in the chats listed. */
  show: Record<Part, Showing>
}

/** The parts of a profile that can each be shown or kept back. The icon is the emoji or the tiny photo. */
export const PARTS = ['icon', 'color', 'contact', 'photo'] as const
export type Part = (typeof PARTS)[number]
export const PART_LABELS: Record<Part, string> = {icon: 'Icon', color: 'Colour', contact: 'Contact', photo: 'Photo'}
export type Showing = {everywhere: boolean; chats: string[]; hidden: string[]}

const nowhere = (): Showing => ({everywhere: false, chats: [], hidden: []})
const showNowhere = (): Record<Part, Showing> => ({icon: nowhere(), color: nowhere(), contact: nowhere(), photo: nowhere()})

/** Whether the profile has anything in this part to show. */
export const hasPart = (profile: Profile, part: Part) =>
  part === 'icon' ? !!(profile.icon || profile.avatar) : part === 'contact' ? !!profile.contact?.value.trim() : !!profile[part]

type Stored = Omit<Profile, 'avatar' | 'photo' | 'show'> & {
  avatar?: string
  photo?: Omit<PictureRef, 'key' | 'preview'> & {key: string; preview: string}
  show?: Partial<Record<Part, Partial<Showing>>>
  // Before each part had its own setting, one applied to the whole profile.
  shareAll?: boolean
  chats?: string[]
}

export function loadProfile(): Profile {
  try {
    const stored = JSON.parse(localStorage.getItem(SETTING) ?? 'null') as Stored | null
    if (stored && typeof stored === 'object') {
      const {shareAll, chats, show, ...rest} = stored
      const whole: Showing = {everywhere: shareAll === true, chats: Array.isArray(chats) ? chats : [], hidden: []}
      const showing = showNowhere()
      for (const part of PARTS) {
        const kept = show?.[part]
        const list = (value: unknown) => (Array.isArray(value) ? (value as string[]) : [])
        showing[part] = kept ? {everywhere: kept.everywhere === true, chats: list(kept.chats), hidden: list(kept.hidden)} : {...whole}
      }
      return {
        ...rest,
        avatar: stored.avatar ? fromHex(stored.avatar) : undefined,
        photo: stored.photo ? {...stored.photo, key: fromHex(stored.photo.key), preview: fromHex(stored.photo.preview)} : undefined,
        show: showing
      }
    }
  } catch {
    // No storage, or nothing usable in it: an empty profile.
  }
  return {show: showNowhere()}
}

export function saveProfile(profile: Profile): void {
  const stored: Stored = {
    ...profile,
    avatar: profile.avatar ? toHex(profile.avatar) : undefined,
    photo: profile.photo ? {...profile.photo, key: toHex(profile.photo.key), preview: toHex(profile.photo.preview)} : undefined
  }
  try {
    localStorage.setItem(SETTING, JSON.stringify(stored))
  } catch {
    // Then it lasts until the page is closed.
  }
}

/** The profile as a card: all of it, or with `chatId` only the parts shown in that chat. */
export function profileCard(profile: Profile, chatId?: string): CardContent {
  const shown = (part: Part) => chatId === undefined || showsIn(profile, part, chatId)
  return {
    type: 'card',
    // A tiny photo stands in place of the emoji.
    ...(!shown('icon') ? {} : profile.avatar ? {avatar: profile.avatar} : profile.icon ? {icon: profile.icon} : {}),
    ...(shown('photo') && profile.photo ? {photo: profile.photo} : {}),
    ...(shown('contact') && profile.contact?.value.trim() ? {contact: {kind: profile.contact.kind, value: profile.contact.value.trim()}} : {}),
    ...(shown('color') && profile.color ? {color: profile.color} : {})
  }
}

export const showsIn = (profile: Profile, part: Part, chatId: string) => {
  const showing = profile.show[part]
  return showing.everywhere ? !showing.hidden.includes(chatId) : showing.chats.includes(chatId)
}

/**
 * Turns one part of the profile on or off for one chat. A part shown in every chat is hidden in just
 * this one; a part shown only where turned on is turned on here.
 */
export function setShownIn(chatId: string, part: Part, shown: boolean): Profile {
  const profile = loadProfile()
  const showing = profile.show[part]
  const without = (list: string[]) => list.filter(id => id !== chatId)
  const next: Showing = showing.everywhere
    ? {...showing, hidden: shown ? without(showing.hidden) : [...without(showing.hidden), chatId]}
    : {...showing, chats: shown ? [...without(showing.chats), chatId] : without(showing.chats)}
  const updated = {...profile, show: {...profile.show, [part]: next}}
  saveProfile(updated)
  return updated
}

/** What to show in a chat: the card and its photo's file, or null if the profile is not shown there. */
export async function cardFor(chatId: string, store: Store): Promise<CardToShare | null> {
  const content = profileCard(loadProfile(), chatId)
  const photoFile = content.photo ? await store.getFile(PROFILE_FILES, content.photo.hash).catch(() => undefined) : undefined
  // A photo whose file has gone missing cannot be passed on.
  if (content.photo && !photoFile) delete content.photo
  return cardIsEmpty(content) ? null : {content, photoFile}
}
