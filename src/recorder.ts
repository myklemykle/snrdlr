// Recording a voice message with the microphone. The recording is made in the first kind this browser
// can record from the list below: AAC in an MP4 file where it can (Safari, and Chrome lately), so that
// iPhones can play everything that is sent; Opus in WebM or Ogg only where it cannot (Firefox).
import {AUDIO_TYPES, MAX_AUDIO_MS, type AudioType} from './envelope'

const WANTED = ['audio/mp4;codecs=mp4a.40.2', 'audio/mp4', 'audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus', 'audio/ogg']

/** Whether this browser can record voice messages at all. */
export const canRecord = () => typeof MediaRecorder !== 'undefined' && !!navigator.mediaDevices?.getUserMedia && WANTED.some(type => MediaRecorder.isTypeSupported(type))

export type Recording = {blob: Blob; mime: AudioType; duration: number}

/** What to tell the person when recording could not start, from what the browser said. */
export function microphoneProblem(error: unknown): string {
  const name = (error as {name?: unknown} | null)?.name
  const iphone = /iPhone|iPad|iPod/.test(navigator.userAgent)
  if (name === 'NotAllowedError' || name === 'SecurityError') {
    // Safari asks once; after "Don't Allow", or with the microphone set to Deny, it refuses without asking.
    return iphone
      ? 'The microphone is turned off for snrdlr. In Safari, tap the aA (or page) button in the address bar, then Website Settings, and set Microphone to Ask or Allow. Then tap the microphone again.'
      : "The microphone is turned off for snrdlr. Allow it for this site in the browser's settings (often the icon at the left of the address bar), then try again."
  }
  if (name === 'NotFoundError' || name === 'OverconstrainedError') return "This device doesn't seem to have a microphone snrdlr can use."
  if (name === 'NotReadableError' || name === 'AbortError') return 'Another app is using the microphone. Close it, or end the call, and try again.'
  return `Recording couldn't start here (${typeof name === 'string' ? name : 'unknown problem'}). Try again, or reload the page.`
}

export type Recorder = {
  /** Stops and gives the recording. */
  stop: () => Promise<Recording>
  /** Stops and throws the recording away. */
  cancel: () => void
  startedAt: number
}

/**
 * Starts recording; asks for the microphone first if the browser has not been allowed it. `onLimit`
 * is called if the recording reaches the longest a voice message may be, which stops it.
 */
export async function startRecording(onLimit: () => void): Promise<Recorder> {
  const stream = await navigator.mediaDevices.getUserMedia({audio: {echoCancellation: true, noiseSuppression: true}})
  const chosen = WANTED.find(type => MediaRecorder.isTypeSupported(type))!
  // A browser that says it can record a kind may still refuse some settings: ask for less, then nothing.
  let recorder: MediaRecorder | undefined
  for (const options of [{mimeType: chosen, audioBitsPerSecond: 32_000}, {mimeType: chosen}, {}]) {
    try {
      recorder = new MediaRecorder(stream, options)
      break
    } catch {
      // The next, plainer one.
    }
  }
  if (!recorder) {
    stream.getTracks().forEach(track => track.stop())
    throw Object.assign(new Error('could not record'), {name: 'NotSupportedError'})
  }
  const chunks: Blob[] = []
  recorder.ondataavailable = event => event.data.size > 0 && chunks.push(event.data)
  const startedAt = Date.now()
  // Some browsers only hand over the recording in pieces as it goes; a second at a time is plenty.
  recorder.start(1000)
  const release = () => stream.getTracks().forEach(track => track.stop())
  const limit = setTimeout(onLimit, MAX_AUDIO_MS - 250)
  const stopped = new Promise<void>(resolve => (recorder.onstop = () => resolve()))
  return {
    startedAt,
    async stop() {
      clearTimeout(limit)
      const duration = Math.min(MAX_AUDIO_MS, Date.now() - startedAt)
      if (recorder.state !== 'inactive') recorder.stop()
      await stopped
      release()
      // The kind as recorded, without its codec, as messages name it.
      const mime = (AUDIO_TYPES.find(type => (recorder.mimeType || chosen).startsWith(type)) ?? 'audio/mp4') as AudioType
      return {blob: new Blob(chunks, {type: mime}), mime, duration}
    },
    cancel() {
      clearTimeout(limit)
      if (recorder.state !== 'inactive') recorder.stop()
      release()
    }
  }
}
