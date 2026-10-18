// Joining from inside the app: reading a code with the camera, or pasting an invite link. A phone's own
// camera app opens links in the browser, which on an iPhone is a different place from the installed
// app, so the installed app has to be able to read codes itself.
import {useEffect, useRef, useState} from 'preact/hooks'
import {isInviteFragment} from './invite'
import {isDeviceFragment} from './link-device'
import {isRemoteFragment} from './remote-invite'

const SCAN_EVERY_MS = 200

/** The invite in a scanned or pasted piece of text, as the part of an address after `#`; null if there is none. */
export function inviteIn(text: string): string | null {
  const at = text.indexOf('#')
  const fragment = at < 0 ? '' : text.slice(at).trim()
  return isInviteFragment(fragment) || isRemoteFragment(fragment) || isDeviceFragment(fragment) ? fragment : null
}

type Reader = (frame: HTMLVideoElement) => Promise<string | null>

/** The browser's own code reader where it has one (Android); otherwise ours, fetched when first needed. */
async function makeReader(): Promise<Reader> {
  const Native = (globalThis as {BarcodeDetector?: new (options: {formats: string[]}) => {detect: (source: HTMLVideoElement) => Promise<{rawValue: string}[]>}})
    .BarcodeDetector
  if (Native) {
    try {
      const detector = new Native({formats: ['qr_code']})
      return async frame => (await detector.detect(frame))[0]?.rawValue ?? null
    } catch {
      // It exists but cannot read QR codes here; fall through to ours.
    }
  }
  const {default: jsQR} = await import('jsqr')
  const canvas = document.createElement('canvas')
  const context = canvas.getContext('2d', {willReadFrequently: true})!
  return async frame => {
    // Half a megapixel is plenty to read a code, and keeps an old phone from struggling.
    const scale = Math.min(1, 720 / Math.max(frame.videoWidth, frame.videoHeight))
    canvas.width = Math.round(frame.videoWidth * scale)
    canvas.height = Math.round(frame.videoHeight * scale)
    if (!canvas.width || !canvas.height) return null
    context.drawImage(frame, 0, 0, canvas.width, canvas.height)
    const pixels = context.getImageData(0, 0, canvas.width, canvas.height)
    return jsQR(pixels.data, pixels.width, pixels.height)?.data ?? null
  }
}

/** The camera, full screen, until it sees a snrdlr code. */
export function Scanner(props: {onFound: (fragment: string) => void; onClose: () => void}) {
  const {onFound, onClose} = props
  const video = useRef<HTMLVideoElement>(null)
  const [problem, setProblem] = useState<string | null>(null)
  const [stray, setStray] = useState(false)

  useEffect(() => {
    let stopped = false
    let stream: MediaStream | null = null
    let timer = 0
    void (async () => {
      try {
        if (!navigator.mediaDevices?.getUserMedia) throw new Error('no camera access')
        stream = await navigator.mediaDevices.getUserMedia({video: {facingMode: 'environment'}, audio: false})
      } catch (error) {
        const refused = error instanceof DOMException && (error.name === 'NotAllowedError' || error.name === 'SecurityError')
        if (!stopped) setProblem(refused ? "snrdlr isn't allowed to use the camera. Allow it in your browser's settings, or paste an invite link." : "Couldn't start a camera on this device. You can paste an invite link.")
        return
      }
      if (stopped || !video.current) return stream.getTracks().forEach(track => track.stop())
      video.current.srcObject = stream
      await video.current.play().catch(() => {})
      const read = await makeReader()
      const look = async () => {
        if (stopped || !video.current) return
        const text = video.current.readyState >= 2 ? await read(video.current).catch(() => null) : null
        if (stopped) return
        const fragment = text === null ? null : inviteIn(text)
        if (fragment) return onFound(fragment)
        // A code is in view, but it is not one of ours.
        setStray(text !== null)
        timer = window.setTimeout(look, SCAN_EVERY_MS)
      }
      void look()
    })()
    const onKey = (event: KeyboardEvent) => event.key === 'Escape' && onClose()
    addEventListener('keydown', onKey)
    return () => {
      stopped = true
      clearTimeout(timer)
      stream?.getTracks().forEach(track => track.stop())
      removeEventListener('keydown', onKey)
    }
  }, [])

  return (
    <div class="scanner" role="dialog" aria-label="Scan a code">
      {/* Inline and muted, or an iPhone opens its own full-screen player instead. */}
      <video ref={video} playsInline muted autoPlay />
      <p class="scanner-note" aria-live="polite">
        {problem ?? (stray ? "That isn't a snrdlr code." : 'Point the camera at a snrdlr code while it is on the other screen.')}
      </p>
      <button type="button" onClick={onClose}>
        Cancel
      </button>
    </div>
  )
}

/** The two ways into a chat from inside the app: scan a code, or paste a link someone sent. */
export function JoinByCode() {
  const [scanning, setScanning] = useState(false)
  const [pasting, setPasting] = useState(false)
  const [link, setLink] = useState('')
  const [problem, setProblem] = useState<string | null>(null)
  // The app notices the invite in the address and joins, exactly as when a link is opened.
  const join = (fragment: string) => {
    setScanning(false)
    setPasting(false)
    setLink('')
    location.hash = fragment
  }
  const usePasted = (event: Event) => {
    event.preventDefault()
    const fragment = inviteIn(link)
    if (fragment) join(fragment)
    else setProblem("That isn't a snrdlr invite link.")
  }
  return (
    <div class="join-by-code">
      <div class="row">
        <button type="button" onClick={() => setScanning(true)}>
          Scan a code
        </button>
        <button
          type="button"
          onClick={() => {
            setProblem(null)
            setPasting(!pasting)
          }}
        >
          Paste a link
        </button>
      </div>
      {pasting && (
        <form class="row" onSubmit={usePasted}>
          <input
            value={link}
            onInput={event => {
              setLink(event.currentTarget.value)
              setProblem(null)
            }}
            placeholder="Invite link"
            aria-label="Invite link"
            autocomplete="off"
            autocapitalize="off"
          />
          <button type="submit" disabled={!link.trim()}>
            Join
          </button>
        </form>
      )}
      {problem && <p class="error">{problem}</p>}
      {scanning && <Scanner onFound={join} onClose={() => setScanning(false)} />}
    </div>
  )
}
