// The service worker: lets the app open with no network, and shows notifications (see src/push.ts).
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

// A push names only the chat's topic. The app leaves each chat's name here (src/push.ts), so the
// notification can say which chat; the message itself is fetched by the app when it is opened.
const LABELS_CACHE = 'snrdlr-push'
const onIos = /iPhone|iPad|iPod/.test(self.navigator.userAgent)

async function labels() {
  try {
    const kept = await (await caches.open(LABELS_CACHE)).match('labels')
    if (kept) return await kept.json()
  } catch {
    // Worded plainly instead.
  }
  return {safari: false, chats: {}}
}

async function notify(topic) {
  const {chats} = await labels()
  const chat = chats[topic]
  // Someone looking at the app already hears and sees what arrives. An iPhone insists on a
  // notification for every push, so it gets one regardless.
  const windows = await self.clients.matchAll({type: 'window', includeUncontrolled: true})
  if (!onIos && windows.some(client => client.visibilityState === 'visible' && client.focused)) return
  // One notification per chat, replaced by the next. It does not count messages: what was read, here
  // or on another device (on an iPhone, in Safari), is never known here, so a count only ever grew.
  await self.registration.showNotification(chat ? chat.name : 'snrdlr', {
    body: 'New message',
    tag: topic || 'snrdlr',
    renotify: true,
    icon: 'bird-192.png',
    data: {id: chat?.id ?? null}
  })
}

self.addEventListener('push', event => {
  let topic = ''
  try {
    topic = event.data?.json()?.t ?? ''
  } catch {
    // A push with nothing readable still says something arrived.
  }
  event.waitUntil(notify(topic))
})

async function open(id) {
  const scope = self.registration.scope
  const chat = id ? `#c=${id}` : ''
  // In the iPhone's Home Screen app, the app opens Safari, where the chats are kept; a notification
  // cannot open Safari by itself.
  if (onIos && (await labels()).safari) return self.clients.openWindow(`${scope}?safari=${encodeURIComponent(chat)}`)
  const windows = await self.clients.matchAll({type: 'window'})
  const app = windows.find(client => client.url.startsWith(scope))
  if (app) {
    await app.focus()
    app.postMessage({open: id})
    return
  }
  return self.clients.openWindow(scope + chat)
}

self.addEventListener('notificationclick', event => {
  event.notification.close()
  event.waitUntil(open(event.notification.data?.id ?? null))
})
