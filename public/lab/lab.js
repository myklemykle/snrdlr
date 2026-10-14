// A throwaway test page: on an iPhone, what opens where, and how long it takes.
// Each copy of the page (Safari, the Home Screen app, an in-app browser sheet) has its own storage,
// so the name kept in localStorage says which copy a page is running in.
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
  if (params.get('forward') === '1') {
    location.href = 'x-safari-' + root + '/lab/?via=' + encodeURIComponent(via + ', forwarded') + '&t=' + sent
    return
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
  var status = add(el('p'))
  function showStatus() {
    status.textContent = 'Permission: ' + (window.Notification ? Notification.permission : 'not available here')
  }
  showStatus()
  var registration = 'serviceWorker' in navigator ? navigator.serviceWorker.register('/lab/sw.js', {scope: '/lab/'}) : null
  button('Allow notifications', 'Asks once.', function () {
    if (!window.Notification) return
    Notification.requestPermission().then(showStatus)
  })
  function notify(mode, body) {
    if (!registration) return alert('No service worker here.')
    registration
      .then(function () {
        return navigator.serviceWorker.ready
      })
      .then(function (ready) {
        return ready.showNotification('snrdlr lab', {body: body, data: {mode: mode}, tag: mode})
      })
      .catch(function (error) {
        alert('Could not show it: ' + error)
      })
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
