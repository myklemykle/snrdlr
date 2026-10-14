// The screens for notifications (push.ts): the part of Settings that turns them on, and the moment in
// the iPhone's Home Screen app between a tapped notification and Safari.
import {useEffect, useState} from 'preact/hooks'
import type {Identity} from './identity'
import {installed, onIos} from './install'
import {opensInSafari, pushState, setOpensInSafari, turnOffPush, turnOnPush, type PushState} from './push'
import type {Store} from './store'

/** The `?safari=` a tapped notification opens the Home Screen app with, holding the chat's own address. */
export function safariHandoff(): string | null {
  const wanted = new URLSearchParams(location.search).get('safari')
  return wanted !== null && onIos() && installed() ? wanted : null
}

/** Sends a tapped notification on to Safari, where the chat is kept, or lets the person stay here. */
export function SafariHandoff(props: {chat: string; onStay: () => void}) {
  const {chat, onStay} = props
  const there = `x-safari-${location.origin}${location.pathname}${chat}`
  useEffect(() => {
    // Taken out of the address, so that opening the app again later does not do this again.
    history.replaceState(null, '', location.pathname)
    location.href = there
  }, [])
  return (
    <main class="home">
      <h1>snrdlr</h1>
      <p>Opening in Safari…</p>
      <div class="row">
        <button type="button" onClick={() => (location.href = there)}>
          Open in Safari
        </button>
        <button type="button" onClick={onStay}>
          Open here
        </button>
      </div>
    </main>
  )
}

const STATE_NOTES: Record<PushState, string> = {
  unsupported: "This browser can't show snrdlr's notifications.",
  'install-first': 'On an iPhone, notifications come through the Home Screen app. Install it (see Install on this iPhone), add it to your snrdlr, and turn them on there.',
  off: "Get a notification when a message arrives while snrdlr isn't open. It says which chat, not what was written.",
  blocked: "Notifications for snrdlr are turned off in this browser's settings. Allow them there, then come back.",
  on: "On. You get a notification when a message arrives while snrdlr isn't open. It says which chat, not what was written."
}

/** The Notifications part of Settings. */
export function NotificationSettings(props: {store: Store; identity: Identity}) {
  const {store, identity} = props
  const [state, setState] = useState<PushState | null>(null)
  const [busy, setBusy] = useState(false)
  const [problem, setProblem] = useState<string | null>(null)
  const [safari, setSafari] = useState(opensInSafari)
  useEffect(() => void pushState().then(setState), [])
  if (state === null) return null
  const change = async (work: () => Promise<PushState>) => {
    setBusy(true)
    setProblem(null)
    try {
      setState(await work())
    } catch {
      setProblem("Couldn't change that just now. Try again in a moment.")
    } finally {
      setBusy(false)
    }
  }
  return (
    <section>
      <h3>Notifications</h3>
      <p class="note">{STATE_NOTES[state]}</p>
      {state === 'off' && (
        <button type="button" disabled={busy} onClick={() => change(() => turnOnPush(store, identity))}>
          Turn on notifications
        </button>
      )}
      {state === 'on' && onIos() && installed() && (
        <label>
          <input
            type="checkbox"
            checked={safari}
            onChange={event => {
              setSafari(event.currentTarget.checked)
              setOpensInSafari(event.currentTarget.checked, store, identity)
            }}
          />{' '}
          Open them in Safari, where you use snrdlr
        </label>
      )}
      {state === 'on' && (
        <button type="button" disabled={busy} onClick={() => change(turnOffPush)}>
          Turn off notifications
        </button>
      )}
      {problem && <p class="error">{problem}</p>}
    </section>
  )
}
