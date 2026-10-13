import {render} from 'preact'
import {App} from './app'
import {unlockSound} from './sound'
import {readDevSwitch} from './standing-invite'
import {watchForUpdates} from './update'
import './style.css'

readDevSwitch()
watchForUpdates()

// Any tap or click lets the browser play message sounds from then on.
addEventListener('pointerdown', unlockSound, {capture: true, passive: true})
addEventListener('keydown', unlockSound, {capture: true, passive: true})

render(<App />, document.getElementById('app')!)
