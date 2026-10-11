/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Origin of the TURN credential worker; TURN is skipped when unset. */
  readonly VITE_TURN_URL?: string
}
