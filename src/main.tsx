import {render, type ComponentChildren} from 'preact'
import {useEffect, useErrorBoundary, useState} from 'preact/hooks'
import {App} from './app'
import {safariHandoff, SafariHandoff} from './push-view'
import {installed, onIos, setUpInstall} from './install'
import {steppedAside, takeOver} from './one-tab'
import {unlockSound} from './sound'
import {readDevSwitch} from './standing-invite'
import {watchForUpdates} from './update'
import './style.css'

readDevSwitch()
// The script loaded, so the page's one reload for a missing script (index.html) is free again.
try {
  sessionStorage.removeItem('snrdlr.scriptReload')
} catch {
  // Then a later missing script is simply not reloaded for.
}
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
    // On an iPhone, every notification tapped in the Home Screen app opens Safari in a new tab, so they
    // pile up. A tab with nothing to go back to closes itself, now and whenever it is looked at again;
    // Safari refuses for any other, which then stays here.
    const close = () => !document.hidden && window.close()
    if (onIos() && !installed()) {
      close()
      document.addEventListener('visibilitychange', close)
    }
    return () => {
      navigator.serviceWorker?.removeEventListener('message', onMessage)
      removeEventListener('hashchange', onTakeOver)
      document.removeEventListener('visibilitychange', close)
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

/**
 * If drawing the app fails, says so and offers a way on, rather than leaving the page blank. What went
 * wrong is shown small, so that whoever sees it can pass it on.
 */
function Guard(props: {children: ComponentChildren}) {
  const [error] = useErrorBoundary()
  if (!error) return <>{props.children}</>
  const detail = error instanceof Error ? `${error.name}: ${error.message}\n${(error.stack ?? '').split('\n').slice(0, 4).join('\n')}` : String(error)
  return (
    <main class="home">
      <h1>snrdlr</h1>
      <p class="error">Something went wrong showing this.</p>
      <div class="row">
        <button type="button" onClick={() => location.reload()}>
          Reload
        </button>
        <button type="button" onClick={() => (location.href = location.pathname)}>
          Go to the chat list
        </button>
      </div>
      <pre class="crash">
        {detail}
        {'\n'}Version {__BUILD__}
      </pre>
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

render(
  <Guard>
    <Root />
  </Guard>,
  document.getElementById('app')!
)
