// Plays a short sound when a message arrives or is sent. The sounds are the files in src/sounds.
//
// Browsers only let a page make noise once the person has tapped or clicked it, so the audio is
// switched on at the first touch. It goes through the Web Audio API, which on an iPhone follows the
// silent switch and plays over music instead of interrupting it.
const SETTING = 'snrdlr.sounds'
// Several messages landing together make one sound, not a burst.
const MIN_GAP_MS = 400

const urls = Object.values(import.meta.glob('./sounds/*.{mp3,wav,m4a}', {eager: true, query: '?url', import: 'default'})) as string[]

let context: AudioContext | null = null
const loaded = new Map<string, Promise<AudioBuffer | null>>()
let lastPlayedAt = 0
let lastUrl: string | null = null

/** On unless the person has turned them off. */
export function soundsOn(): boolean {
  try {
    return localStorage.getItem(SETTING) !== '0'
  } catch {
    return true
  }
}

export function setSoundsOn(on: boolean): void {
  try {
    localStorage.setItem(SETTING, on ? '1' : '0')
  } catch {
    // The choice then lasts until the page is closed, which is no worse than not having it.
  }
  if (on) unlockSound()
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
  if (urls.length === 0 || !soundsOn()) return
  try {
    if (!context) {
      // Tells an iPhone these are interface sounds: quiet when the silent switch is on, and no interruption to music.
      const session = (navigator as Navigator & {audioSession?: {type: string}}).audioSession
      if (session) session.type = 'ambient'
      context = new AudioContext()
      urls.forEach(url => void load(context!, url))
    }
    if (context.state === 'suspended') void context.resume().catch(() => {})
  } catch {
    // No audio on this device.
  }
}

/** Plays one of the sounds, chosen at random, if sounds are on and the browser allows it yet. */
export function playSound(): void {
  const now = Date.now()
  if (!context || context.state !== 'running' || !soundsOn() || now - lastPlayedAt < MIN_GAP_MS) return
  lastPlayedAt = now
  // Not the same one twice running, when there is a choice.
  const choices = urls.length > 1 ? urls.filter(url => url !== lastUrl) : urls
  const url = choices[Math.floor(Math.random() * choices.length)]
  lastUrl = url
  const audio = context
  void load(audio, url).then(buffer => {
    if (!buffer || audio.state !== 'running') return
    const source = audio.createBufferSource()
    source.buffer = buffer
    source.connect(audio.destination)
    source.start()
  })
}
