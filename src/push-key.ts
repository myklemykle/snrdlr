// The relay's public push key (VAPID), which a browser is given when it subscribes, so that only our
// relay can push to it. Written by scripts/push-keys.mjs, which puts the private half into the relay
// as a secret. Empty until then, and notifications are not offered.
export const PUSH_PUBLIC_KEY = ''
