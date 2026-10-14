// A throwaway test page: on an iPhone, what opens where, and how long it takes.
// Each copy of the page (Safari, the Home Screen app, an in-app browser sheet) has its own storage,
// so the name kept in localStorage says which copy a page is running in.
import {relayMailboxes} from '../src/mailbox'
import {RELAYS} from '../src/relays'
import {utf8} from '../src/bytes'

// A throwaway key pair made for this test; the private half is only on the developer's computer.
const VAPID_PUBLIC = 'BInpCTgdhVfpP1fAls7j9n1DnAwp7Ryf_oghPWfG2yy-giNgvKmslkMz3mK5Cxx8ABmJd_snsSxlkcgwGU4OlTw'
// Where the phone leaves its push address for the developer to pick up.
const LAB_TOPIC = 'snrdlr-lab-push-test'

;(function () {
  var params = new URLSearchParams(location.search)
  var via = params.get('via')
  var sent = Number(params.get('t'))
  var standalone = matchMedia('(display-mode: standalone)').matches || navigator.standalone === true
  var root = 'https://' + location.host

  function get(key) {
    try {
      return localStorage.getItem(key)
    } catch (e) {
      return null
    }
  }
  function set(key, value) {
    try {
      localStorage.setItem(key, value)
    } catch (e) {}
  }

  // Name this copy the first time it is seen.
  var name = get('lab.copy')
  var note = ''
  if (standalone && name !== 'Home Screen app') {
    if (name) note = 'This app started with the storage of "' + name + '": it was copied in at install.'
    name = 'Home Screen app'
    set('lab.copy', name)
  } else if (!name) {
    if (!via) name = 'Safari'
    else name = 'NEW copy ' + Math.random().toString(36).slice(2, 6) + ' (neither Safari nor the app: probably a browser sheet inside the app)'
    set('lab.copy', name)
  }

  // A notification tap that is meant to go on to Safari passes through here first.
  // The app then carries on showing its own page; left on an empty one, it looked stuck when you came back.
  if (params.get('forward') === '1') {
    history.replaceState(null, '', '/lab/?via=' + encodeURIComponent(via + ' (sent on to Safari)'))
    location.href = 'x-safari-' + root + '/lab/?via=' + encodeURIComponent(via + ', forwarded') + '&t=' + sent
    via = via + ' (sent on to Safari)'
    sent = 0
  }

  var ms = via && sent ? Date.now() - sent : null
  var log = []
  try {
    log = JSON.parse(get('lab.log') || '[]')
  } catch (e) {}
  if (via) {
    log.unshift({via: via, ms: ms, at: new Date().toLocaleTimeString(), path: location.pathname, standalone: standalone})
    log = log.slice(0, 30)
    set('lab.log', JSON.stringify(log))
  }

  var main = document.getElementById('lab')
  function el(tag, attrs, text) {
    var node = document.createElement(tag)
    for (var key in attrs || {}) node.setAttribute(key, attrs[key])
    if (text) node.textContent = text
    return node
  }
  function add(node) {
    main.appendChild(node)
    return node
  }

  add(el('h1', null, 'snrdlr lab'))
  var where = add(el('div', {class: 'where'}))
  where.appendChild(el('b', {class: 'big'}, name))
  where.appendChild(el('div', null, (standalone ? 'Running full screen, as an app' : 'Running in a browser') + ' · page ' + location.pathname))
  if (via) where.appendChild(el('div', null, 'Got here by: ' + via + (ms !== null ? ' · took ' + ms + ' ms' : '')))
  if (note) where.appendChild(el('div', null, note))

  function linkButton(label, hint, makeUrl, target) {
    var a = add(el('a', {class: 'button', href: makeUrl()}))
    a.appendChild(el('div', null, label))
    a.appendChild(el('small', null, hint))
    if (target) a.setAttribute('target', target)
    // The time is stamped as the finger lifts, so the page that opens can say how long the trip took.
    a.addEventListener('click', function () {
      a.setAttribute('href', makeUrl())
    })
  }
  function stamp(url) {
    return url + '&t=' + Date.now()
  }
  function button(label, hint, onClick) {
    var b = add(el('button', {type: 'button'}))
    b.appendChild(el('div', null, label))
    b.appendChild(el('small', null, hint))
    b.addEventListener('click', onClick)
    return b
  }

  add(el('h2', null, 'Links'))
  linkButton('1. Ordinary link to this page', 'Baseline: should stay where it is.', function () {
    return stamp('/lab/?via=1 ordinary link')
  })
  linkButton('2. Link opening a new window', 'target=_blank, same app address.', function () {
    return stamp('/lab/?via=2 new window')
  }, '_blank')
  linkButton('3. Link outside the app’s address', 'Goes to /lab-out/, which the app does not own.', function () {
    return stamp('/lab-out/?via=3 outside link')
  })
  linkButton('4. x-safari-https link', 'Meant to open Safari itself.', function () {
    return stamp('x-safari-' + root + '/lab/?via=4 x-safari link')
  })
  button('5. x-safari-https by script', 'What a forwarding app would do: no link, just code.', function () {
    location.href = stamp('x-safari-' + root + '/lab/?via=5 x-safari by script')
  })
  button('6. window.open, outside address', 'Another way a script can open a page.', function () {
    window.open(stamp(root + '/lab-out/?via=6 window.open'), '_blank')
  })

  add(el('h2', null, 'Notifications'))
  add(el('p', null, 'These only work in the Home Screen app. After tapping one of the "Show" buttons, go to the Home Screen, pull down Notification Center if no banner appears, and tap the notification.'))
  var status = add(el('div', {class: 'where'}))
  var steps = []
  function say(line) {
    steps.push(new Date().toLocaleTimeString() + ' ' + line)
    showStatus()
  }
  function showStatus() {
    status.textContent = ''
    status.appendChild(el('div', null, 'Permission: ' + (window.Notification ? Notification.permission : 'not available here')))
    status.appendChild(el('div', null, 'Push: ' + ('PushManager' in window ? 'available' : 'not available here')))
    steps.slice(-8).forEach(function (line) {
      status.appendChild(el('div', null, line))
    })
  }
  showStatus()
  var registration = null
  if ('serviceWorker' in navigator) {
    registration = navigator.serviceWorker.register('/lab/sw.js', {scope: '/lab/'})
    registration.then(
      function (found) {
        say('Service worker: ' + (found.active ? 'active' : found.installing ? 'installing' : found.waiting ? 'waiting' : 'registered'))
      },
      function (error) {
        say('Service worker failed: ' + error)
      }
    )
  } else say('No service workers here.')
  // Waits for the service worker, but says so if it never turns up.
  function ready() {
    if (!registration) return Promise.reject(new Error('no service worker'))
    return Promise.race([
      registration.then(function () {
        return navigator.serviceWorker.ready
      }),
      new Promise(function (_, reject) {
        setTimeout(function () {
          reject(new Error('the service worker never became ready'))
        }, 8000)
      })
    ])
  }
  button('Allow notifications', 'Asks once.', function () {
    if (!window.Notification) return say('Notifications are not available here.')
    Notification.requestPermission().then(function (answer) {
      say('Asked: ' + answer)
    })
  })
  function notify(mode, body) {
    say('Showing (' + mode + ')…')
    ready()
      .then(function (worker) {
        return worker.showNotification('snrdlr lab', {body: body, data: {mode: mode}, tag: mode})
      })
      .then(
        function () {
          say('The phone accepted it without complaint.')
        },
        function (error) {
          say('Could not show it: ' + error)
        }
      )
  }
  button('7. Show: tap opens the app', 'One hop, for comparison.', function () {
    notify('app', 'Tap me: opens the Home Screen app')
  })
  button('8. Show: tap goes straight to Safari', 'The notification itself opens an x-safari-https link.', function () {
    notify('direct', 'Tap me: straight to Safari')
  })
  button('9. Show: tap opens the app, which forwards to Safari', 'Two hops.', function () {
    notify('forward', 'Tap me: app, then Safari')
  })

  add(el('h2', null, 'Real push'))
  add(el('p', null, 'This is how snrdlr would really do it: the phone gets a push address from Apple and leaves it with our relay, and a server sends to it. Tap 10, then tell Claude. Three pushes will come, one of each kind above, a few seconds apart; tap each.'))
  button('10. Sign up for real pushes', 'Then go back to the Home Screen and wait.', function () {
    say('Signing up…')
    ready()
      .then(function (worker) {
        return worker.pushManager.getSubscription().then(function (old) {
          return old || worker.pushManager.subscribe({userVisibleOnly: true, applicationServerKey: VAPID_PUBLIC})
        })
      })
      .then(function (subscription) {
        say('Got a push address at ' + new URL(subscription.endpoint).host)
        var box = relayMailboxes(RELAYS[0])(LAB_TOPIC, undefined, {onEnvelope: function () {}})
        return box.post(utf8(JSON.stringify(subscription)), Date.now()).then(function (kept) {
          box.close()
          say(kept ? 'Left with the relay. Tell Claude it is ready.' : 'The relay did not take it; try again.')
        })
      })
      .catch(function (error) {
        say('Could not sign up: ' + error)
      })
  })

  add(el('h2', null, 'What has landed in this copy'))
  if (log.length === 0) add(el('p', null, 'Nothing yet.'))
  var list = add(el('ol'))
  log.forEach(function (entry) {
    list.appendChild(
      el('li', null, entry.at + ' · ' + entry.via + (entry.ms !== null ? ' · ' + entry.ms + ' ms' : '') + ' · ' + (entry.standalone ? 'full screen' : 'browser') + ' · ' + entry.path)
    )
  })
  button('Clear this list', '', function () {
    set('lab.log', '[]')
    location.replace(location.pathname)
  })
  add(el('p', null, navigator.userAgent)).style.fontSize = '12px'
})()
