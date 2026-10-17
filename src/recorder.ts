// Recording a voice message with the microphone. The recording is made in the first kind this browser
// can record from the list below: AAC in an MP4 file where it can (Safari, and Chrome lately), so that
// iPhones can play everything that is sent; Opus in WebM or Ogg only where it cannot (Firefox).
import {AUDIO_TYPES, MAX_AUDIO_MS, type AudioType} from './envelope'

const WANTED = ['audio/mp4;codecs=mp4a.40.2', 'audio/mp4', 'audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus', 'audio/ogg']

/** Whether this browser can record voice messages at all. */
export const canRecord = () => typeof MediaRecorder !== 'undefined' && !!navigator.mediaDevices?.getUserMedia && WANTED.some(type => MediaRecorder.isTypeSupported(type))

export type Recording = {blob: Blob; mime: AudioType; duration: number}

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
  const recorder = new MediaRecorder(stream, {mimeType: chosen, audioBitsPerSecond: 32_000})
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
