// The lab's service worker: only here so the lab can show notifications and see where a tap leads.
self.addEventListener('install', function () {
  self.skipWaiting()
})
self.addEventListener('activate', function (event) {
  event.waitUntil(self.clients.claim())
})

self.addEventListener('notificationclick', function (event) {
  event.notification.close()
  var t = Date.now()
  var root = self.location.origin
  var mode = event.notification.data && event.notification.data.mode
  var url =
    mode === 'direct'
      ? 'x-safari-' + root + '/lab/?via=8 notification straight to Safari&t=' + t
      : mode === 'forward'
        ? root + '/lab/?via=9 notification via app&forward=1&t=' + t
        : root + '/lab/?via=7 notification to app&t=' + t
  event.waitUntil(
    self.clients.openWindow(url).catch(function (error) {
      // If the system refuses the x-safari link, say so in the app instead.
      return self.clients.openWindow(root + '/lab/?via=' + encodeURIComponent('8 refused: ' + error) + '&t=' + t)
    })
  )
})
