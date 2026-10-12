/// <reference types="vite/client" />

/** When this build was made and from which commit. */
declare const __BUILD__: string

interface ImportMetaEnv {
  /** Origin of the TURN credential worker; TURN is skipped when unset. */
  readonly VITE_TURN_URL?: string
  /** Comma-separated Nostr relay URLs, for local testing; the public defaults are used when unset. */
  readonly VITE_NOSTR_RELAYS?: string
  /** How long a joiner waits for an invite to answer, in milliseconds; shortened in tests. */
  readonly VITE_JOIN_TIMEOUT_MS?: string
}
