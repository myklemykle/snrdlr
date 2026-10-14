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
  /** Shown in every chat; otherwise only in the chats listed. */
  shareAll: boolean
  chats: string[]
}

type Stored = Omit<Profile, 'avatar' | 'photo'> & {avatar?: string; photo?: Omit<PictureRef, 'key' | 'preview'> & {key: string; preview: string}}

export function loadProfile(): Profile {
  try {
    const stored = JSON.parse(localStorage.getItem(SETTING) ?? 'null') as Stored | null
    if (stored && typeof stored === 'object') {
      return {
        ...stored,
        avatar: stored.avatar ? fromHex(stored.avatar) : undefined,
        photo: stored.photo ? {...stored.photo, key: fromHex(stored.photo.key), preview: fromHex(stored.photo.preview)} : undefined,
        shareAll: stored.shareAll === true,
        chats: Array.isArray(stored.chats) ? stored.chats : []
      }
    }
  } catch {
    // No storage, or nothing usable in it: an empty profile.
  }
  return {shareAll: false, chats: []}
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

/** The profile as a card, whether or not it is shown anywhere. */
export function profileCard(profile: Profile): CardContent {
  return {
    type: 'card',
    // A tiny photo stands in place of the emoji.
    ...(profile.avatar ? {avatar: profile.avatar} : profile.icon ? {icon: profile.icon} : {}),
    ...(profile.photo ? {photo: profile.photo} : {}),
    ...(profile.contact?.value.trim() ? {contact: {kind: profile.contact.kind, value: profile.contact.value.trim()}} : {}),
    ...(profile.color ? {color: profile.color} : {})
  }
}

export const showsIn = (profile: Profile, chatId: string) => profile.shareAll || profile.chats.includes(chatId)

/** Turns the profile on or off for one chat. */
export function setShownIn(chatId: string, shown: boolean): Profile {
  const profile = loadProfile()
  const chats = profile.chats.filter(id => id !== chatId)
  const next = {...profile, chats: shown ? [...chats, chatId] : chats}
  saveProfile(next)
  return next
}

/** What to show in a chat: the card and its photo's file, or null if the profile is not shown there. */
export async function cardFor(chatId: string, store: Store): Promise<CardToShare | null> {
  const profile = loadProfile()
  if (!showsIn(profile, chatId)) return null
  const content = profileCard(profile)
  const photoFile = content.photo ? await store.getFile(PROFILE_FILES, content.photo.hash).catch(() => undefined) : undefined
  // A photo whose file has gone missing cannot be passed on.
  if (content.photo && !photoFile) delete content.photo
  return cardIsEmpty(content) ? null : {content, photoFile}
}
