/// <reference types="vite/client" />

/** When this build was made and from which commit. */
declare const __BUILD__: string

interface ImportMetaEnv {
  /** Origin of the TURN credential worker; TURN is skipped when unset. */
  readonly VITE_TURN_URL?: string
  /** Comma-separated Nostr relay URLs, for local testing; the public defaults are used when unset. */
  readonly VITE_NOSTR_RELAYS?: string
  /** The relay that keeps sealed messages; for local testing. */
  readonly VITE_STORE_RELAY?: string
  /** How long a joiner waits for an invite to answer, in milliseconds; shortened in tests. */
  readonly VITE_JOIN_TIMEOUT_MS?: string
  /** How often an open tab looks for a newer build, and how long it must be idle before reloading; shortened in tests. */
  readonly VITE_UPDATE_CHECK_MS?: string
  readonly VITE_UPDATE_IDLE_MS?: string
}
