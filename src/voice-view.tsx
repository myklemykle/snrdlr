// Voice messages on screen: the player in a message, and the bar in the composer while recording and
// before sending.
import {useEffect, useRef, useState} from 'preact/hooks'
import type {AudioContent} from './envelope'
import {openFile} from './files'
import type {Store} from './store'

/** Minutes and seconds, as a voice message's length is usually written. */
export const clock = (ms: number) => {
  const seconds = Math.max(0, Math.round(ms / 1000))
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`
}

const SPEEDS = [1, 1.5, 2]

/** Plays a recording: play and pause, a position that can be dragged, the time, and the speed. */
export function VoicePlayer(props: {url: string | null; duration: number; waiting?: string}) {
  const {url, duration, waiting} = props
  const audio = useRef<HTMLAudioElement>(null)
  const [playing, setPlaying] = useState(false)
  const [at, setAt] = useState(0)
  const [speed, setSpeed] = useState(1)
  useEffect(() => {
    const element = audio.current
    if (element) element.playbackRate = speed
  }, [speed, url])
  const toggle = () => {
    const element = audio.current
    if (!element) return
    if (element.paused) void element.play().catch(() => setPlaying(false))
    else element.pause()
  }
  const length = duration / 1000
  return (
    <span class="voice">
      {url && (
        <audio
          ref={audio}
          src={url}
          preload="metadata"
          onPlay={() => setPlaying(true)}
          onPause={() => setPlaying(false)}
          onEnded={() => {
            setPlaying(false)
            setAt(0)
          }}
          onTimeUpdate={event => setAt(event.currentTarget.currentTime)}
        />
      )}
      <button type="button" class="play" aria-label={playing ? 'Pause' : 'Play'} disabled={!url} onClick={toggle}>
        {playing ? (
          <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
            <rect x="6" y="5" width="4" height="14" rx="1" fill="currentColor" />
            <rect x="14" y="5" width="4" height="14" rx="1" fill="currentColor" />
          </svg>
        ) : (
          <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
            <path d="M8 5v14l11-7z" fill="currentColor" />
          </svg>
        )}
      </button>
      <input
        type="range"
        class="position"
        min="0"
        max={length || 1}
        step="0.1"
        value={at}
        disabled={!url}
        aria-label="Position"
        onInput={event => {
          const next = Number(event.currentTarget.value)
          setAt(next)
          if (audio.current) audio.current.currentTime = next
        }}
      />
      <span class="time">{waiting ?? (at > 0 ? `${clock(at * 1000)} / ${clock(duration)}` : clock(duration))}</span>
      <button type="button" class="speed" aria-label={`Speed ${speed}×`} onClick={() => setSpeed(SPEEDS[(SPEEDS.indexOf(speed) + 1) % SPEEDS.length])}>
        {speed}×
      </button>
    </span>
  )
}

/** A voice message in the chat: played once its recording is on this device. */
export function VoiceMessage(props: {store: Store; chatId: string; audio: AudioContent; held: boolean}) {
  const {store, chatId, audio, held} = props
  const [url, setUrl] = useState<string | null>(null)
  useEffect(() => {
    if (!held) return
    let cancelled = false
    let made: string | null = null
    void (async () => {
      const file = await store.getFile(chatId, audio.hash)
      if (!file || cancelled) return
      const plain = await openFile(file, audio.key)
      if (cancelled) return
      made = URL.createObjectURL(new Blob([new Uint8Array(plain)], {type: audio.mime}))
      setUrl(made)
    })().catch(() => {})
    return () => {
      cancelled = true
      if (made) URL.revokeObjectURL(made)
      setUrl(null)
    }
  }, [held, audio.hash])
  return <VoicePlayer url={url} duration={audio.duration} waiting={held ? undefined : 'Fetching…'} />
}

/** While recording: how long so far, and stopping or throwing it away. */
export function RecordingBar(props: {startedAt: number; onStop: () => void; onCancel: () => void}) {
  const {startedAt, onStop, onCancel} = props
  const [, tick] = useState(0)
  useEffect(() => {
    const timer = setInterval(() => tick(n => n + 1), 250)
    return () => clearInterval(timer)
  }, [])
  return (
    <div class="recording" role="status" aria-label="Recording your voice">
      <span class="dot" aria-hidden="true" />
      <span class="time">{clock(Date.now() - startedAt)}</span>
      <span class="what">Recording</span>
      <button type="button" onClick={onCancel}>
        Delete
      </button>
      <button type="button" class="stop" onClick={onStop}>
        Stop
      </button>
    </div>
  )
}
