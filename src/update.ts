// Keeps a long-open tab from running an old version of the app for ever. Each build publishes a small
// file naming itself; a tab that finds a different name there reloads once nobody is using it.
//
// It also keeps a record, for this tab, of when it started and why, so that a tab which reloaded to
// update can be told apart from one the browser discarded and brought back.
import {useEffect, useState} from 'preact/hooks'

const CHECK_MS = Number(import.meta.env.VITE_UPDATE_CHECK_MS) || 10 * 60 * 1000
// How long without a tap or a key before a visible tab counts as not in use. A hidden tab counts at once.
const IDLE_MS = Number(import.meta.env.VITE_UPDATE_IDLE_MS) || 5 * 60 * 1000
// Session storage belongs to one tab and survives its reloads, which is what these need.
const HOLD_KEY = 'snrdlr.holdUpdates'
const UPDATED_KEY = 'snrdlr.updatedItselfAt'
const TRIED_KEY = 'snrdlr.updateTried'

const recall = (key: string) => {
  try {
    return sessionStorage.getItem(key)
  } catch {
    return null
  }
}
const record = (key: string, value: string | null) => {
  try {
    if (value === null) sessionStorage.removeItem(key)
    else sessionStorage.setItem(key, value)
  } catch {
    // Without storage the tab simply forgets across reloads.
  }
}

export type UpdateState = {
  /** When this page was loaded. */
  startedAt: number
  /** Set if that load was the tab updating itself. */
  updatedItself: boolean
  /** A newer version has been published and this tab has not moved to it yet. */
  ready: boolean
  /** Updates are being held back in this tab, for testing. */
  held: boolean
}

const startedAt = Date.now()
// Only believed if recent: otherwise a later, unrelated reload would be mistaken for an update.
const updatedItself = startedAt - Number(recall(UPDATED_KEY) ?? 0) < 60_000
let ready = false
let lastInput = Date.now()
const busy = new Set<symbol>()
const watchers = new Set<() => void>()

const snapshot = (): UpdateState => ({startedAt, updatedItself, ready, held: recall(HOLD_KEY) === '1'})
const announce = () => watchers.forEach(watcher => watcher())

export function holdUpdates(hold: boolean): void {
  record(HOLD_KEY, hold ? '1' : null)
  announce()
  maybeReload()
}

/** Reloads to take the update, if there is one and nothing is in the way. */
function maybeReload(): void {
  if (!ready || busy.size > 0 || recall(HOLD_KEY) === '1') return
  if (!document.hidden && Date.now() - lastInput < IDLE_MS) return
  // Tried once for this version already and still not on it: the new files are not being served yet, or
  // something is wrong. Leave it to the person, so the tab cannot reload over and over.
  if (recall(TRIED_KEY) === latest) return
  record(TRIED_KEY, latest)
  record(UPDATED_KEY, String(Date.now()))
  location.reload()
}

let latest: string | null = null

async function check(): Promise<void> {
  try {
    const response = await fetch('version.json', {cache: 'no-store'})
    if (!response.ok) return
    const published = ((await response.json()) as {build?: unknown}).build
    if (typeof published !== 'string') return
    latest = published
    const now = published !== __BUILD__
    if (now !== ready) {
      ready = now
      announce()
    }
    maybeReload()
  } catch {
    // Offline, or not served with a version file; try again later.
  }
}

/** Starts watching for new versions. Call once. */
export function watchForUpdates(): void {
  const noteInput = () => (lastInput = Date.now())
  addEventListener('pointerdown', noteInput, {capture: true, passive: true})
  addEventListener('keydown', noteInput, {capture: true, passive: true})
  document.addEventListener('visibilitychange', () => void check())
  setInterval(() => void check(), CHECK_MS)
  // Between checks, the wait is only for the tab to fall idle.
  setInterval(maybeReload, Math.min(30_000, IDLE_MS))
  void check()
}

/** The update state, kept current. */
export function useUpdateState(): UpdateState {
  const [state, setState] = useState(snapshot)
  useEffect(() => {
    const watcher = () => setState(snapshot())
    watchers.add(watcher)
    // Anything that changed between the first draw and now would otherwise be missed.
    watcher()
    return () => void watchers.delete(watcher)
  }, [])
  return state
}

/** While `active`, the tab will not reload to update: something is half done that a reload would lose. */
export function useUpdateHold(active: boolean): void {
  useEffect(() => {
    if (!active) return
    const token = Symbol()
    busy.add(token)
    return () => {
      busy.delete(token)
    }
  }, [active])
}
