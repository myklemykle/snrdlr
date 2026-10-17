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

// Where each set starts, chosen by ear. A set not listed plays as its files were made.
const DEFAULT_VOLUMES: Record<string, number> = {snrdl: 0.1, plink: 0.5, groovy: 0.1}

export function soundVolume(choice: string): number {
  const usual = DEFAULT_VOLUMES[choice] ?? 1
  try {
    const stored = localStorage.getItem(volumeKey(choice))
    const volume = stored === null ? usual : Number(stored)
    return Number.isFinite(volume) ? Math.min(MAX_VOLUME, Math.max(0, volume)) : usual
  } catch {
    return usual
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

// An iPhone stops a page's audio when the browser goes out of sight or another app plays something,
// and the stopped audio does not always start again when asked: it can even claim to be running and
// stay silent. So after any such spell the audio is thrown away and made afresh at the next tap.
let stale = false
if (typeof document !== 'undefined') {
  document.addEventListener('visibilitychange', () => {
    if (document.hidden && context) stale = true
  })
}

/**
 * What an iPhone is told the page's audio is for (Safari's navigator.audioSession). Message sounds are
 * "ambient": quiet with the silent switch on, and no interruption to music. But an ambient page cannot
 * record (the microphone fails with InvalidStateError), and a voice message should be heard even with
 * the silent switch on, as in any other app; so recording and playing one change it for as long as they
 * last. Elsewhere there is nothing to tell.
 */
export function audioFor(use: 'sounds' | 'recording' | 'listening'): void {
  const session = (navigator as Navigator & {audioSession?: {type: string}}).audioSession
  if (!session) return
  try {
    session.type = use === 'recording' ? 'play-and-record' : use === 'listening' ? 'playback' : 'ambient'
  } catch {
    // An older Safari: as it was.
  }
}

/** Call from a tap or click. Until one has happened, the browser will not let anything play. */
export function unlockSound(): void {
  const wanted = urls()
  if (wanted.length === 0) return
  try {
    if (context && (stale || (context.state as string) === 'interrupted' || context.state === 'closed')) {
      void context.close().catch(() => {})
      context = null
      // Sounds are decoded by the audio they will play through.
      loaded.clear()
    }
    stale = false
    if (!context) {
      // Tells an iPhone these are interface sounds: quiet when the silent switch is on, and no interruption to music.
      audioFor('sounds')
      context = new AudioContext()
      const made = context
      // If the phone stops it later, start over rather than trust it to resume.
      made.onstatechange = () => {
        if (context === made && (made.state as string) === 'interrupted') stale = true
      }
    }
    // Fetches the chosen set ahead of time, so the first sound is not late.
    wanted.forEach(url => void load(context!, url))
    // An iPhone also stops the audio ("interrupted") when the page has been in the background.
    if (context.state !== 'running') void context.resume().catch(() => {})
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
  if (!context || wanted.length === 0 || (!sample && now - lastPlayedAt < MIN_GAP_MS)) return
  if (context.state !== 'running') {
    // Trying out a setting happens in a tap, which is when the audio may be switched on; wait for that.
    if (sample) void context.resume().then(() => context?.state === 'running' && playSound(true), () => {})
    return
  }
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
