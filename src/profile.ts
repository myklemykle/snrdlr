// The person's own profile, beyond their name: kept on each of their devices, the same on all (devices.ts), and shown in a chat only as a card
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
  /** By chat, something other than the usual to show there instead. */
  instead?: Record<string, Instead>
}

/** The parts that can be something else in one chat. The photo is the same everywhere. */
export const ALTERABLE = ['icon', 'color', 'contact'] as const
export type Alterable = (typeof ALTERABLE)[number]
export type Instead = {icon?: string; avatar?: Uint8Array; color?: string; contact?: {kind: ContactKind; value: string}}

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

type StoredInstead = Omit<Instead, 'avatar'> & {avatar?: string}
type Stored = Omit<Profile, 'avatar' | 'photo' | 'show' | 'instead'> & {
  instead?: Record<string, StoredInstead>
  /** When it was last changed on any of the person's devices; missing until changed since this was kept. */
  updatedAt?: number
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
      const instead: Record<string, Instead> = {}
      for (const [chatId, here] of Object.entries(stored.instead ?? {})) {
        if (here && typeof here === 'object') instead[chatId] = {...here, avatar: here.avatar ? fromHex(here.avatar) : undefined}
      }
      return {
        ...rest,
        instead,
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

/** Saves a change made here, or (with `at`) one that arrived from another of the person's devices. */
export function saveProfile(profile: Profile, at = Date.now()): void {
  const stored: Stored = {
    ...profile,
    updatedAt: at,
    avatar: profile.avatar ? toHex(profile.avatar) : undefined,
    photo: profile.photo ? {...profile.photo, key: toHex(profile.photo.key), preview: toHex(profile.photo.preview)} : undefined,
    instead: Object.fromEntries(Object.entries(profile.instead ?? {}).map(([chatId, here]) => [chatId, {...here, avatar: here.avatar ? toHex(here.avatar) : undefined}]))
  }
  try {
    localStorage.setItem(SETTING, JSON.stringify(stored))
  } catch {
    // Then it lasts until the page is closed.
  }
}

/** When the profile was last changed, here or on another of the person's devices; 0 if never since this was kept. */
export function profileUpdatedAt(): number {
  try {
    const at = (JSON.parse(localStorage.getItem(SETTING) ?? 'null') as Stored | null)?.updatedAt
    return typeof at === 'number' && Number.isFinite(at) ? at : 0
  } catch {
    return 0
  }
}

/** The profile as the person's other devices are told it (devices.ts): as it is kept, with their name. */
export function profileNote(name: string): string {
  try {
    const stored = JSON.parse(localStorage.getItem(SETTING) ?? '{}') as Stored
    delete stored.updatedAt
    return JSON.stringify({...stored, name})
  } catch {
    return JSON.stringify({name})
  }
}

/** Takes up the profile another device told of, as written at `at`. Returns the name it gave. */
export function takeProfileNote(text: string, at: number): string | null {
  const {name, ...stored} = JSON.parse(text) as Stored & {name?: unknown}
  if (typeof stored !== 'object' || stored === null) throw new Error('not a profile')
  try {
    localStorage.setItem(SETTING, JSON.stringify({...stored, updatedAt: at}))
  } catch {
    // Then this device keeps what it had.
  }
  // Read back through loadProfile, which mends anything malformed, and saved again in its form.
  saveProfile(loadProfile(), at)
  return typeof name === 'string' ? name : null
}

/** The profile as a card: all of it, or with `chatId` only the parts shown in that chat, as they are there. */
export function profileCard(profile: Profile, chatId?: string): CardContent {
  const shown = (part: Part) => chatId === undefined || showsIn(profile, part, chatId)
  const here = chatId === undefined ? profile : asIn(profile, chatId)
  return {
    type: 'card',
    // A tiny photo stands in place of the emoji.
    ...(!shown('icon') ? {} : here.avatar ? {avatar: here.avatar} : here.icon ? {icon: here.icon} : {}),
    ...(shown('photo') && profile.photo ? {photo: profile.photo} : {}),
    ...(shown('contact') && here.contact?.value.trim() ? {contact: {kind: here.contact.kind, value: here.contact.value.trim()}} : {}),
    ...(shown('color') && here.color ? {color: here.color} : {})
  }
}

/** Whether a part is something other than the usual in this chat. */
export const isInstead = (profile: Profile, part: Alterable, chatId: string) => {
  const here = profile.instead?.[chatId]
  return !!here && (part === 'icon' ? here.icon !== undefined || here.avatar !== undefined : here[part] !== undefined)
}

/** The profile as it is in one chat: the usual, with whatever is something else there in its place. */
export function asIn(profile: Profile, chatId: string): Profile {
  const here = profile.instead?.[chatId]
  if (!here) return profile
  return {
    ...profile,
    ...(isInstead(profile, 'icon', chatId) ? {icon: here.icon, avatar: here.avatar} : {}),
    ...(isInstead(profile, 'color', chatId) ? {color: here.color} : {}),
    ...(isInstead(profile, 'contact', chatId) ? {contact: here.contact} : {})
  }
}

/**
 * Shows something other than the usual for one part in one chat, and shows that part there; or, given
 * null, goes back to the usual.
 */
export function setInstead(chatId: string, part: Alterable, value: Instead | null): Profile {
  const profile = loadProfile()
  const here: Instead = {...profile.instead?.[chatId]}
  if (part === 'icon') {
    delete here.icon
    delete here.avatar
  } else delete here[part]
  if (value) Object.assign(here, part === 'icon' ? {icon: value.icon, avatar: value.avatar} : {[part]: value[part]})
  const instead = {...profile.instead}
  if (Object.keys(here).length > 0) instead[chatId] = here
  else delete instead[chatId]
  saveProfile({...profile, instead})
  return value && !showsIn(profile, part, chatId) ? setShownIn(chatId, part, true) : loadProfile()
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
