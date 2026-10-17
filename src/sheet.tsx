// A sheet over the page, for Settings and profiles: a title and a close button that stay put at the
// top, and below them whatever the sheet holds, which scrolls by itself when it is long. Only the part
// below the title scrolls, inside the sheet's rounded frame, so a scrollbar never squares its corners.
import type {ComponentChildren} from 'preact'

export function Sheet(props: {
  label: string
  title: string
  class?: string
  onClose: () => void
  /** What a tap beside the sheet does, if not closing it. */
  onBackdrop?: () => void
  children?: ComponentChildren
}) {
  const {label, title, onClose, onBackdrop, children} = props
  return (
    <div class="sheet-backdrop" onClick={onBackdrop ?? onClose}>
      <section class={`sheet${props.class ? ` ${props.class}` : ''}`} role="dialog" aria-label={label} onClick={event => event.stopPropagation()}>
        <header class="sheet-head">
          <h2>{title}</h2>
          <button type="button" class="close" aria-label="Close" onClick={onClose}>
            <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true">
              <path d="M6 6l12 12M18 6L6 18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" />
            </svg>
          </button>
        </header>
        <div class="sheet-body">{children}</div>
      </section>
    </div>
  )
}
