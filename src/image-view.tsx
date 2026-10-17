// A picture in the chat: its tiny preview at once, the real thing when the file is on this device.
import {useEffect, useMemo, useState} from 'preact/hooks'
import {IMAGE_MIME, type ImageContent} from './envelope'
import {openImage} from './image'
import type {Store} from './store'

/** A URL for a stored picture, once it has been opened; null until then, or if it cannot be. */
export function useImageUrl(store: Store, chatId: string, image: ImageContent, held: boolean): string | null {
  const [url, setUrl] = useState<string | null>(null)
  useEffect(() => {
    if (!held) return
    let cancelled = false
    let made: string | null = null
    void (async () => {
      const file = await store.getFile(chatId, image.hash)
      if (!file || cancelled) return
      const blob = await openImage(file, image)
      if (cancelled) return
      made = URL.createObjectURL(blob)
      setUrl(made)
    })().catch(() => {})
    return () => {
      cancelled = true
      if (made) URL.revokeObjectURL(made)
      setUrl(null)
    }
  }, [held, image.hash])
  return url
}

export function ImageView(props: {
  store: Store
  chatId: string
  image: ImageContent
  held: boolean
  /** Whether anyone is connected who might have the file. */
  connected: boolean
  from: string
  onOpen: (url: string) => void
}) {
  const {store, chatId, image, held, connected, from, onOpen} = props
  const url = useImageUrl(store, chatId, image, held)
  const preview = useMemo(
    () => (image.preview.length > 0 ? URL.createObjectURL(new Blob([new Uint8Array(image.preview)], {type: IMAGE_MIME})) : null),
    [image.hash]
  )
  useEffect(() => () => void (preview && URL.revokeObjectURL(preview)), [preview])
  const label = `Picture from ${from}`

  return (
    <button
      type="button"
      class="picture"
      style={{aspectRatio: `${image.width} / ${image.height}`, width: `${Math.min(18, (18 * image.width) / image.height)}rem`}}
      aria-label={url ? `${label}. Open` : `${label}, not here yet`}
      aria-disabled={!url}
      onClick={() => url && onOpen(url)}
    >
      {preview && <img class="blur" src={preview} alt="" />}
      {url ? (
        <img class="full" src={url} alt={label} draggable={false} />
      ) : (
        <span class="waiting">{connected ? 'Loading…' : 'Will arrive when someone who has it is online'}</span>
      )}
    </button>
  )
}

/** Whether this device hands pictures to its own share sheet, as phones and tablets do. */
function canShareImages(): boolean {
  try {
    const sample = new File([new Uint8Array(1)], 'picture.jpg', {type: IMAGE_MIME})
    return matchMedia('(pointer: coarse)').matches && !!navigator.share && !!navigator.canShare?.({files: [sample]})
  } catch {
    return false
  }
}

// Each platform has its own sign for "share": Apple's box with an arrow, and the three joined dots
// used on Android and elsewhere.
const APPLE = /iPhone|iPad|iPod|Macintosh/.test(navigator.userAgent)

const AppleShareIcon = () => (
  <svg viewBox="0 0 24 24" width="24" height="24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
    <path d="M12 15V3.5" />
    <path d="M8 7l4-4 4 4" />
    <path d="M8.5 10.5H7a2 2 0 0 0-2 2V19a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-6.5a2 2 0 0 0-2-2h-1.5" />
  </svg>
)

const ShareIcon = () => (
  <svg viewBox="0 0 24 24" width="24" height="24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round">
    <circle cx="18" cy="5" r="2.6" fill="currentColor" stroke="none" />
    <circle cx="6" cy="12" r="2.6" fill="currentColor" stroke="none" />
    <circle cx="18" cy="19" r="2.6" fill="currentColor" stroke="none" />
    <path d="M8.2 10.8l7.6-4.5M8.2 13.2l7.6 4.5" />
  </svg>
)

/** A picture filling the screen, with a way to keep it. */
export function ImageViewer(props: {url: string; onClose: () => void}) {
  const {url, onClose} = props
  const [note, setNote] = useState<string | null>(null)
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => event.key === 'Escape' && onClose()
    addEventListener('keydown', onKey)
    return () => removeEventListener('keydown', onKey)
  }, [])

  // Phones offer "Save Image" in their share sheet; elsewhere the browser downloads it.
  const [sharing] = useState(canShareImages)
  const save = async () => {
    const blob = await (await fetch(url)).blob()
    const gif = blob.type === 'image/gif'
    const name = `snrdlr-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.${gif ? 'gif' : 'jpg'}`
    try {
      if (sharing) {
        await navigator.share({files: [new File([blob], name, {type: gif ? 'image/gif' : IMAGE_MIME})]})
        return
      }
    } catch (error) {
      // Closing the share sheet is not a failure.
      if (error instanceof DOMException && error.name === 'AbortError') return
    }
    const link = document.createElement('a')
    link.href = url
    link.download = name
    link.click()
    setNote('Saved to your downloads.')
  }

  return (
    <div class="viewer" role="dialog" aria-label="Picture" onClick={onClose}>
      <img src={url} alt="" onClick={event => event.stopPropagation()} />
      <div class="viewer-bar" onClick={event => event.stopPropagation()}>
        {note && <span class="note">{note}</span>}
        {sharing ? (
          <button type="button" class="icon" onClick={save} aria-label="Share or save">
            {APPLE ? <AppleShareIcon /> : <ShareIcon />}
          </button>
        ) : (
          <button type="button" onClick={save}>
            Save
          </button>
        )}
        <button type="button" onClick={onClose} aria-label="Close picture">
          ✕
        </button>
      </div>
    </div>
  )
}
