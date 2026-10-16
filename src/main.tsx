import {render} from 'preact'
import {useEffect, useState} from 'preact/hooks'
import {App} from './app'
import {safariHandoff, SafariHandoff} from './push-view'
import {setUpInstall} from './install'
import {steppedAside, takeOver} from './one-tab'
import {unlockSound} from './sound'
import {readDevSwitch} from './standing-invite'
import {watchForUpdates} from './update'
import './style.css'

readDevSwitch()
watchForUpdates()
setUpInstall()

// Any tap, click or key lets the browser play message sounds from then on. Which moment counts differs:
// for a finger it is when it lifts, not when it lands (an iPhone is strict about this), and for a mouse
// it is when the button goes down.
for (const moment of ['pointerdown', 'pointerup', 'touchend', 'click', 'keydown']) {
  addEventListener(moment, unlockSound, {capture: true, passive: true})
}

/** A tab that stepped aside for a newer one: nothing but the offer to take over again. */
function SteppedAside(props: {onTakeOver: () => void}) {
  const {onTakeOver} = props
  useEffect(() => {
    // A tapped notification, or a link opened here, means this is the tab the person wants now.
    const onMessage = (event: MessageEvent) => {
      const open = (event.data as {open?: unknown} | null)?.open
      if (open === undefined) return
      // The app opens on the chat it was asked for.
      if (typeof open === 'string') history.replaceState(null, '', `${location.pathname}#c=${open}`)
      onTakeOver()
    }
    navigator.serviceWorker?.addEventListener('message', onMessage)
    addEventListener('hashchange', onTakeOver)
    return () => {
      navigator.serviceWorker?.removeEventListener('message', onMessage)
      removeEventListener('hashchange', onTakeOver)
    }
  }, [])
  return (
    <main class="home">
      <h1>snrdlr</h1>
      <p>snrdlr is open in another tab. Only one tab at a time keeps your chats connected.</p>
      <div class="row">
        <button type="button" onClick={onTakeOver}>
          Use it here
        </button>
      </div>
    </main>
  )
}

/** The app, unless a notification tapped in the iPhone's Home Screen app is on its way to Safari. */
function Root() {
  const [handoff, setHandoff] = useState(safariHandoff)
  const [aside, setAside] = useState(steppedAside)
  if (aside) {
    return (
      <SteppedAside
        onTakeOver={() => {
          takeOver()
          setAside(false)
        }}
      />
    )
  }
  if (handoff === null) return <App />
  return (
    <SafariHandoff
      chat={handoff}
      onStay={() => {
        history.replaceState(null, '', location.pathname + handoff)
        setHandoff(null)
      }}
    />
  )
}

// The newest tab is the one, unless this tab stepped aside earlier and was only reloaded or brought back.
if (!steppedAside()) takeOver()

render(<Root />, document.getElementById('app')!)
