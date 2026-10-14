import {render} from 'preact'
import {App} from './app'
import {unlockSound} from './sound'
import {readDevSwitch} from './standing-invite'
import {watchForUpdates} from './update'
import './style.css'

readDevSwitch()
watchForUpdates()

// Any tap, click or key lets the browser play message sounds from then on. Which moment counts differs:
// for a finger it is when it lifts, not when it lands (an iPhone is strict about this), and for a mouse
// it is when the button goes down.
for (const moment of ['pointerdown', 'pointerup', 'touchend', 'click', 'keydown']) {
  addEventListener(moment, unlockSound, {capture: true, passive: true})
}

render(<App />, document.getElementById('app')!)
