// snrdlr is invite-only: a device can use the app once it has joined a chat through someone's invite.
//
// This is a courtesy gate, not a lock. It runs in the visitor's own browser, so anyone who reads the
// code can step around it. What it does is stop someone who merely finds the address from setting up
// and inviting their own circle. Refusing them for real would need our servers to check a pass.
import {devMode} from './standing-invite'

const KEY = 'snrdlr.invited'

/**
 * Whether this device may use the app. `established` says whether it already had a name or chats, which
 * lets in everyone who was using the app before the gate existed. The answer is recorded the first
 * time it is asked, so that giving a name later does not count as having been invited.
 */
export function isAdmitted(established: boolean): boolean {
  if (devMode()) return true
  try {
    const recorded = localStorage.getItem(KEY)
    if (recorded !== null) return recorded === '1'
    localStorage.setItem(KEY, established ? '1' : '0')
  } catch {
    // Nowhere to record it; go by what is on the device.
  }
  return established
}

/** Records that this device has joined a chat by invite. */
export function admit(): void {
  try {
    localStorage.setItem(KEY, '1')
  } catch {
    // It then lasts as long as the chat it joined, which `isAdmitted` also counts.
  }
}
