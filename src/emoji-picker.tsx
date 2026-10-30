// A grid of every emoji, for choosing a reaction. Browsers give a page no way to open the system's own
// emoji keyboard, so the app carries a list (src/emoji-data.json, loaded only when the picker opens).
import {useEffect, useMemo, useRef, useState} from 'preact/hooks'
import {BIRDS, firstEmoji, isBird} from './emoji'
import {Emoji, emojiLabel} from './emoji-view'

type Entry = [emoji: string, name: string, version: number, words?: string]
type Group = [name: string, emojis: Entry[]]

const BIRD_GROUP = 'snrdlr'
// The app's own birds come first; every device can draw them.
const BIRD_ENTRIES: Entry[] = BIRDS.map(([name, words]) => [`:bird-${name}:`, `bird ${name.replace(/-/g, ' ')}`, 0, `snrdlr ${words}`])

const GROUP_ICONS: Record<string, string> = {
  [BIRD_GROUP]: ':bird-look-at-you:',
  'Smileys & Emotion': '😀',
  'People & Body': '👋',
  'Animals & Nature': '🐻',
  'Food & Drink': '🍔',
  'Travel & Places': '🚗',
  Activities: '⚽',
  Objects: '💡',
  Symbols: '🔣',
  Flags: '🏁'
}
const RECENT_KEY = 'snrdlr.recentEmoji'
const MAX_RECENT = 24
const MAX_RESULTS = 150

export function recentEmoji(): string[] {
  try {
    const stored = JSON.parse(localStorage.getItem(RECENT_KEY) ?? '[]') as unknown
    return Array.isArray(stored) ? stored.filter(item => typeof item === 'string').slice(0, MAX_RECENT) : []
  } catch {
    return []
  }
}

function noteUsed(emoji: string) {
  try {
    localStorage.setItem(RECENT_KEY, JSON.stringify([emoji, ...recentEmoji().filter(other => other !== emoji)].slice(0, MAX_RECENT)))
  } catch {
    // Recents are a convenience.
  }
}

// One emoji from each version of the Emoji standard, newest first. A device draws the ones it knows as a
// single colour picture the width of any other emoji; the rest come out as a box or as several pictures.
const VERSION_PROBES: [number, string][] = [
  [17, '🫪'],
  [16, '🫩'],
  [15.1, '🙂‍↔️'],
  [15, '🫨'],
  [14, '🫠'],
  [13.1, '😶‍🌫️'],
  [13, '🥲'],
  [12.1, '🧑‍🦰'],
  [12, '🥱'],
  [11, '🥰']
]
const OLDEST_ASSUMED = 5
let supportedVersion: number | null = null

/** The newest version of the Emoji standard this device can draw, so the picker offers no empty boxes. */
export function supportedEmojiVersion(): number {
  if (supportedVersion !== null) return supportedVersion
  supportedVersion = OLDEST_ASSUMED
  try {
    const canvas = document.createElement('canvas')
    canvas.width = canvas.height = 64
    const context = canvas.getContext('2d', {willReadFrequently: true})!
    context.font = '32px "Apple Color Emoji", "Segoe UI Emoji", "Noto Color Emoji", sans-serif'
    context.textBaseline = 'top'
    const expected = context.measureText('😀').width
    const drawn = (emoji: string) => {
      if (Math.abs(context.measureText(emoji).width - expected) > expected * 0.1) return false
      context.clearRect(0, 0, 64, 64)
      context.fillStyle = '#000'
      context.fillText(emoji, 0, 0)
      const pixels = context.getImageData(0, 0, 64, 64).data
      // A box for a missing character is drawn in the text colour; an emoji has colour of its own.
      for (let i = 0; i < pixels.length; i += 4) {
        if (pixels[i + 3] > 0 && (Math.abs(pixels[i] - pixels[i + 1]) > 24 || Math.abs(pixels[i + 1] - pixels[i + 2]) > 24)) return true
      }
      return false
    }
    // If even the plain face is not drawn in colour, the test tells us nothing; offer everything.
    if (!drawn('😀')) return (supportedVersion = Infinity)
    supportedVersion = VERSION_PROBES.find(([, emoji]) => drawn(emoji))?.[0] ?? OLDEST_ASSUMED
  } catch {
    supportedVersion = Infinity
  }
  return supportedVersion
}

export function EmojiPicker(props: {onPick: (emoji: string) => void; onClose: () => void}) {
  const {onPick, onClose} = props
  const [groups, setGroups] = useState<Group[] | null>(null)
  const [query, setQuery] = useState('')
  const grid = useRef<HTMLDivElement>(null)
  const panel = useRef<HTMLElement>(null)
  const search = useRef<HTMLInputElement>(null)

  useEffect(() => {
    let cancelled = false
    void import('./emoji-data.json').then(module => {
      if (cancelled) return
      const newest = supportedEmojiVersion()
      const all = module.default as unknown as Group[]
      setGroups([[BIRD_GROUP, BIRD_ENTRIES], ...all.map(([name, emojis]): Group => [name, emojis.filter(([, , version]) => version <= newest)])])
    })
    return () => {
      cancelled = true
    }
  }, [])

  // With a mouse and keyboard, typing to search is the quick way. On a touch screen that would raise
  // the keyboard over the grid, so the search box waits to be tapped.
  useEffect(() => {
    if (matchMedia('(hover: hover) and (pointer: fine)').matches) search.current?.focus()
    const onKey = (event: KeyboardEvent) => event.key === 'Escape' && onClose()
    addEventListener('keydown', onKey)
    return () => removeEventListener('keydown', onKey)
  }, [])

  // Sits at the bottom of what is actually visible, which on an iPhone is above the keyboard.
  useEffect(() => {
    const viewport = window.visualViewport
    if (!viewport) return
    const place = () => {
      const hidden = Math.max(0, window.innerHeight - (viewport.offsetTop + viewport.height))
      panel.current?.style.setProperty('--hidden-below', `${hidden}px`)
      panel.current?.style.setProperty('--visible-height', `${viewport.height}px`)
    }
    place()
    viewport.addEventListener('resize', place)
    viewport.addEventListener('scroll', place)
    return () => {
      viewport.removeEventListener('resize', place)
      viewport.removeEventListener('scroll', place)
    }
  }, [])

  const names = useMemo(() => new Map((groups ?? []).flatMap(([, emojis]) => emojis.map(([emoji, name]) => [emoji, name] as const))), [groups])
  const recent = useMemo(recentEmoji, [])
  const words = query.toLowerCase().split(/\s+/).filter(Boolean)
  const results = useMemo(() => {
    if (!groups || words.length === 0) return null
    // Each word typed must be in the emoji's name or its everyday search words ("haha" finds 😂).
    const found = groups
      .flatMap(([, emojis]) => emojis)
      .filter(([, name, , extra = '']) => {
        const searched = `${name} ${extra}`.toLowerCase()
        return words.every(word => searched.includes(word))
      })
    // Something typed or pasted that is itself an emoji can be used, whether or not it is in the list.
    const typed = firstEmoji(query)
    const typedEntry: Entry[] = typed && !found.some(([emoji]) => emoji === typed) ? [[typed, names.get(typed) ?? typed, 0]] : []
    return [...typedEntry, ...found].slice(0, MAX_RESULTS)
  }, [groups, query])

  const pick = (emoji: string) => {
    noteUsed(emoji)
    onPick(emoji)
  }
  const cell = ([emoji, name]: Entry | [string, string]) => (
    <button key={emoji} type="button" title={name} aria-label={isBird(emoji) ? emojiLabel(emoji) : name} onClick={() => pick(emoji)}>
      <Emoji emoji={emoji} />
    </button>
  )
  const jumpTo = (name: string) => grid.current?.querySelector(`[data-group="${name}"]`)?.scrollIntoView({block: 'start'})

  return (
    <section class="picker" role="dialog" aria-label="Choose an emoji" ref={panel}>
      <div class="picker-top">
        <input
          ref={search}
          type="search"
          value={query}
          onInput={event => setQuery(event.currentTarget.value)}
          placeholder="Search emoji"
          aria-label="Search emoji"
          autocomplete="off"
        />
        <button type="button" onClick={onClose} aria-label="Close emoji picker">
          ✕
        </button>
      </div>
      {!results && groups && (
        <nav class="picker-tabs" aria-label="Emoji groups">
          {groups.map(([name]) => (
            <button key={name} type="button" aria-label={name} title={name} onClick={() => jumpTo(name)}>
              <Emoji emoji={GROUP_ICONS[name] ?? name[0]} />
            </button>
          ))}
        </nav>
      )}
      <div class="picker-grid" ref={grid}>
        {!groups && <p class="note">Loading…</p>}
        {results && (results.length > 0 ? <div class="cells">{results.map(cell)}</div> : <p class="note">No emoji found for "{query.trim()}".</p>)}
        {!results && recent.length > 0 && groups && (
          <section aria-label="Recently used">
            <h3>Recently used</h3>
            <div class="cells">{recent.map(emoji => cell([emoji, names.get(emoji) ?? emoji]))}</div>
          </section>
        )}
        {!results &&
          groups?.map(([name, emojis]) => (
            <section key={name} data-group={name} aria-label={name}>
              <h3>{name}</h3>
              <div class="cells">{emojis.map(cell)}</div>
            </section>
          ))}
      </div>
    </section>
  )
}
