import {render} from 'preact'
import {useState} from 'preact/hooks'
import {App} from './app'
import {safariHandoff, SafariHandoff} from './push-view'
import {setUpInstall} from './install'
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

/** The app, unless a notification tapped in the iPhone's Home Screen app is on its way to Safari. */
function Root() {
  const [handoff, setHandoff] = useState(safariHandoff)
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

render(<Root />, document.getElementById('app')!)
