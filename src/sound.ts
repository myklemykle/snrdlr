// Plays a short sound when a message arrives or is sent, from whichever set of sounds the person chose.
// The sets are the folders in src/sounds.
//
// Browsers only let a page make noise once the person has tapped or clicked it, so the audio is
// switched on at the first touch. It goes through the Web Audio API, which on an iPhone follows the
// silent switch and plays over music instead of interrupting it.
const SETTING = 'snrdlr.soundSet'
// Before there were sets, this held '0' when sounds were turned off.
const OLD_SETTING = 'snrdlr.sounds'
// Several messages landing together make one sound, not a burst.
const MIN_GAP_MS = 400

/** The choice that plays nothing. */
export const SILENT = 'shhhhh'
const DEFAULT_SET = 'snrdl'

// Every folder in src/sounds is a set, named after the folder.
const sets = new Map<string, string[]>()
for (const [path, url] of Object.entries(import.meta.glob('./sounds/*/*.{mp3,wav,m4a}', {eager: true, query: '?url', import: 'default'}))) {
  const name = path.split('/')[2]
  sets.set(name, [...(sets.get(name) ?? []), url as string])
}
const FIRST = [DEFAULT_SET, 'plink']

/** What Settings offers, in order: the sets, then silence. */
export const SOUND_CHOICES = [...FIRST.filter(name => sets.has(name)), ...[...sets.keys()].filter(name => !FIRST.includes(name)).sort(), SILENT]

let context: AudioContext | null = null
const loaded = new Map<string, Promise<AudioBuffer | null>>()
let lastPlayedAt = 0
let lastUrl: string | null = null

/** The chosen set, or SILENT. */
export function soundChoice(): string {
  try {
    const stored = localStorage.getItem(SETTING)
    if (stored && SOUND_CHOICES.includes(stored)) return stored
    if (localStorage.getItem(OLD_SETTING) === '0') return SILENT
  } catch {
    // Storage is unavailable; fall through to the default.
  }
  return SOUND_CHOICES[0]
}

export function setSoundChoice(choice: string): void {
  try {
    localStorage.setItem(SETTING, choice)
  } catch {
    // The choice then lasts until the page is closed, which is no worse than not having it.
  }
  unlockSound()
}

const urls = () => sets.get(soundChoice()) ?? []

/** Volume runs from silent to twice as loud as the files were made; each set has its own. */
export const MAX_VOLUME = 2
const volumeKey = (choice: string) => `snrdlr.soundVolume.${choice}`

export function soundVolume(choice: string): number {
  try {
    const stored = Number(localStorage.getItem(volumeKey(choice)) ?? '1')
    return Number.isFinite(stored) ? Math.min(MAX_VOLUME, Math.max(0, stored)) : 1
  } catch {
    return 1
  }
}

export function setSoundVolume(choice: string, volume: number): void {
  try {
    localStorage.setItem(volumeKey(choice), String(volume))
  } catch {
    // As with the choice of set.
  }
}

const load = (audio: AudioContext, url: string) => {
  if (!loaded.has(url)) {
    loaded.set(
      url,
      fetch(url)
        .then(response => response.arrayBuffer())
        .then(bytes => audio.decodeAudioData(bytes))
        .catch(() => null)
    )
  }
  return loaded.get(url)!
}

/** Call from a tap or click. Until one has happened, the browser will not let anything play. */
export function unlockSound(): void {
  const wanted = urls()
  if (wanted.length === 0) return
  try {
    if (!context) {
      // Tells an iPhone these are interface sounds: quiet when the silent switch is on, and no interruption to music.
      const session = (navigator as Navigator & {audioSession?: {type: string}}).audioSession
      if (session) session.type = 'ambient'
      context = new AudioContext()
    }
    // Fetches the chosen set ahead of time, so the first sound is not late.
    wanted.forEach(url => void load(context!, url))
    if (context.state === 'suspended') void context.resume().catch(() => {})
  } catch {
    // No audio on this device.
  }
}

/**
 * Plays one sound from the chosen set, picked at random, if the browser allows it yet. `sample` is for
 * trying out a setting: it plays even if another sound has only just played.
 */
export function playSound(sample = false): void {
  const now = Date.now()
  const wanted = urls()
  if (!context || context.state !== 'running' || wanted.length === 0 || (!sample && now - lastPlayedAt < MIN_GAP_MS)) return
  lastPlayedAt = now
  // Not the same one twice running, when there is a choice.
  const choices = wanted.length > 1 ? wanted.filter(url => url !== lastUrl) : wanted
  const url = choices[Math.floor(Math.random() * choices.length)]
  lastUrl = url
  const audio = context
  void load(audio, url).then(buffer => {
    if (!buffer || audio.state !== 'running') return
    const source = audio.createBufferSource()
    source.buffer = buffer
    const gain = audio.createGain()
    gain.gain.value = soundVolume(soundChoice())
    source.connect(gain).connect(audio.destination)
    source.start()
  })
}
