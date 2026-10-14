// The service worker: lets the app open with no network, and is where notifications will arrive.
//
// It is deliberately plain and rarely changes. The page is always fetched fresh when there is a
// network, so a new version of the app is never held back by this file; what is kept here is only
// used when the network fails. The app's scripts and styles have names that change with their
// contents, so a kept copy of one is always the right one.
const SHELL = 'snrdlr-shell-v1'
const MAX_KEPT = 80

self.addEventListener('install', () => self.skipWaiting())
self.addEventListener('activate', event => event.waitUntil(self.clients.claim()))

async function keep(key, response) {
  if (!response.ok || response.type !== 'basic') return
  const cache = await caches.open(SHELL)
  await cache.put(key, response)
  // Old versions' files are dropped, oldest first, once there are more than a few versions' worth.
  const keys = await cache.keys()
  await Promise.all(keys.slice(0, Math.max(0, keys.length - MAX_KEPT)).map(old => cache.delete(old)))
}

async function freshFirst(request, key) {
  try {
    const response = await fetch(request)
    void keep(key, response.clone())
    return response
  } catch (error) {
    const kept = await caches.match(key)
    if (kept) return kept
    throw error
  }
}

async function keptFirst(request) {
  const kept = await caches.match(request)
  if (kept) return kept
  const response = await fetch(request)
  void keep(request, response.clone())
  return response
}

self.addEventListener('fetch', event => {
  const {request} = event
  const url = new URL(request.url)
  if (request.method !== 'GET' || url.origin !== self.location.origin || !url.href.startsWith(self.registration.scope)) return
  // Which version is out must always come from the network.
  if (url.pathname.endsWith('/version.json')) return
  // The page itself, whatever its address says after ? or #: one copy, kept under the app's own address.
  if (request.mode === 'navigate') event.respondWith(freshFirst(request, self.registration.scope))
  else if (url.pathname.includes('/assets/')) event.respondWith(keptFirst(request))
  else event.respondWith(freshFirst(request, request))
})
