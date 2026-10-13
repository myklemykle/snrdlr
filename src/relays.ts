// The Nostr relays through which devices find each other. Two copies of the app can only meet if
// their lists share a relay, so change this slowly: ours stays in every version, and at most one
// of the others should change per release.
export const RELAYS = [
  // Ours (worker-relay/): passes connection setup only and stores nothing.
  'wss://snrdlr-relay.snrdlr.workers.dev',
  // The five that Trystero's default list gave this app before the list was pinned here. To be
  // replaced by the best of the relays measured by scripts/probe-relays.mjs.
  'wss://relay.grigic.org',
  'wss://nostr.chaima.info',
  'wss://relay.flashapp.me',
  'wss://nostr.red5d.dev',
  'wss://relay.routstr.com'
]
