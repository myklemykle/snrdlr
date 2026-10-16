// One snrdlr tab at a time in each browser. Every open tab holds its own connections to the relays and
// to other devices, and phones pile tabs up (a scanned code opens a new one each time), which costs the
// relay dearly and confuses which tab has what. So the newest tab takes over, and any other steps
// aside: it reloads into a page that holds no connections and offers to take over again.
//
// It uses the browser's Web Locks, which tabs of one site share. Where they are missing, every tab
// carries on as before.

const LOCK = 'snrdlr.tab'
const STEPPED_ASIDE = 'snrdlr.steppedAside'

function flag(value?: boolean): boolean {
  try {
    if (value === true) sessionStorage.setItem(STEPPED_ASIDE, '1')
    else if (value === false) sessionStorage.removeItem(STEPPED_ASIDE)
    return sessionStorage.getItem(STEPPED_ASIDE) === '1'
  } catch {
    return false
  }
}

/** Whether this tab has stepped aside for another, and should show only that. */
export const steppedAside = () => !!navigator.locks && flag()

/**
 * Makes this tab the one, taking over from any other. When another tab later takes over, this one
 * reloads into its stepped-aside page.
 */
export function takeOver(): void {
  flag(false)
  if (!navigator.locks) return
  navigator.locks
    .request(LOCK, {steal: true}, () => new Promise<void>(() => {}))
    .catch(() => {
      // Taken by a newer tab. Starting again from nothing is the surest way to let go of everything.
      flag(true)
      location.reload()
    })
}
