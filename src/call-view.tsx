// Snrdlephoning on screen: the call (call.ts) as a chat runs it, and the panel that shows it.
import {useEffect, useMemo, useRef, useState} from 'preact/hooks'
import {makeCall, type Call, type CallEnd, type CallState} from './call'
import {microphoneProblem} from './recorder'
import type {Session} from './session'
import {audioFor} from './sound'
import type {MessageRecord} from './store'

const END_NOTES: Record<Exclude<CallEnd, 'no microphone'>, string> = {
  'no answer': 'No answer',
  declined: 'Busy right now',
  ended: 'Call ended',
  taken: 'Answered on another device',
  lost: 'The call dropped'
}
// How long the note saying how a call ended stays up.
const END_NOTE_MS = 4000

/** Runs calls for a direct chat; null for a group. */
export function useCall(props: {
  /** The other person in a direct chat. */
  otherId: string | null
  selfId: string
  session: {current: Session | null}
  peers: string[]
  messages: MessageRecord[] | null
}) {
  const {otherId, selfId, session, peers, messages} = props
  const [state, setState] = useState<CallState>({phase: 'idle'})
  const [sound, setSound] = useState<MediaStream | null>(null)
  const [note, setNote] = useState<string | null>(null)
  const peersNow = useRef(peers)
  peersNow.current = peers
  const micError = useRef<unknown>(null)
  // Played from the tap that starts or answers a call, so that an iPhone lets it play the other side later.
  const speaker = useRef<HTMLAudioElement | null>(null)

  const call = useMemo<Call | null>(
    () =>
      otherId
        ? makeCall({
            selfId,
            otherId,
            wire: () => session.current?.callWire() ?? null,
            peers: () => peersNow.current,
            post: content => session.current?.postCall(content) ?? Promise.reject(new Error('not open')),
            microphone: async () => {
              // An iPhone records only with its audio set for it, and then plays the call aloud too.
              audioFor('recording')
              try {
                return await navigator.mediaDevices.getUserMedia({audio: {echoCancellation: true, noiseSuppression: true, autoGainControl: true}})
              } catch (error) {
                micError.current = error
                throw error
              }
            },
            onState: setState,
            onSound: setSound,
            onEnd: why => setNote(why === 'no microphone' ? microphoneProblem(micError.current) : END_NOTES[why])
          })
        : null,
    [otherId]
  )
  useEffect(() => void (messages && call?.messages(messages)), [call, messages])
  useEffect(() => call?.peersChanged(), [call, peers])
  useEffect(() => () => call?.close(), [call])

  // Their side, played as it comes.
  useEffect(() => {
    const element = speaker.current
    if (!element) return
    element.srcObject = sound
    if (sound) void element.play().catch(() => {})
  }, [sound])

  const busy = state.phase !== 'idle'
  // The screen stays on during a call, and the audio goes back to message sounds after it.
  useEffect(() => {
    if (!busy) {
      audioFor('sounds')
      return
    }
    type Lock = {release: () => Promise<void>}
    let lock: Lock | null = null
    let over = false
    const hold = () => {
      if (document.hidden || over) return
      const wakeLock = (navigator as Navigator & {wakeLock?: {request: (type: 'screen') => Promise<Lock>}}).wakeLock
      void wakeLock?.request('screen').then(
        held => (over ? void held.release() : (lock = held)),
        () => {}
      )
    }
    hold()
    document.addEventListener('visibilitychange', hold)
    return () => {
      over = true
      document.removeEventListener('visibilitychange', hold)
      void lock?.release().catch(() => {})
    }
  }, [busy])

  // A ring while it is ringing here.
  const ringing = state.phase === 'ringing'
  useEffect(() => {
    if (!ringing) return
    const stop = ring()
    return stop
  }, [ringing])

  useEffect(() => {
    if (!note) return
    const timer = setTimeout(() => setNote(null), note.length > 40 ? END_NOTE_MS * 3 : END_NOTE_MS)
    return () => clearTimeout(timer)
  }, [note])

  /** Wraps a tap's action so the speaker is unlocked by the same tap. */
  const tapped = (action: () => unknown) => () => {
    setNote(null)
    void speaker.current?.play().catch(() => {})
    void action()
  }

  return {
    call,
    state,
    note,
    busy,
    speaker,
    start: tapped(() => call?.start()),
    answer: tapped(() => call?.answer()),
    decline: () => call?.decline(),
    hangUp: () => call?.hangUp(),
    mute: (muted: boolean) => call?.mute(muted)
  }
}

/** Two short tones every couple of seconds, and a buzz where a phone can, until stopped. */
function ring(): () => void {
  let context: AudioContext | null = null
  try {
    context = new AudioContext()
  } catch {
    // No sound, then: the screen still shows the call.
  }
  const once = () => {
    navigator.vibrate?.([400, 200, 400])
    if (!context) return
    const start = context.currentTime
    for (const [at, pitch] of [[0, 880], [0.25, 660]] as const) {
      const tone = context.createOscillator()
      const level = context.createGain()
      tone.frequency.value = pitch
      level.gain.setValueAtTime(0.0001, start + at)
      level.gain.exponentialRampToValueAtTime(0.25, start + at + 0.02)
      level.gain.exponentialRampToValueAtTime(0.0001, start + at + 0.22)
      tone.connect(level).connect(context.destination)
      tone.start(start + at)
      tone.stop(start + at + 0.25)
    }
  }
  once()
  const timer = setInterval(once, 2000)
  return () => {
    clearInterval(timer)
    navigator.vibrate?.(0)
    void context?.close().catch(() => {})
  }
}

/** Minutes and seconds since the call was answered, ticking. */
function Elapsed(props: {since: number}) {
  const [now, setNow] = useState(Date.now())
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [])
  const seconds = Math.max(0, Math.floor((now - props.since) / 1000))
  return <span class="elapsed">{`${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`}</span>
}

/** The call, over the chat while it lasts. */
export function CallPanel(props: {name: string; calling: ReturnType<typeof useCall>}) {
  const {name, calling} = props
  const {state} = calling
  if (state.phase === 'idle') return calling.note ? <p class="call-note" role="status">{calling.note}</p> : null
  return (
    <div class="call-panel" role="dialog" aria-label="Snrdlephone call">
      <p class="who">{name}</p>
      {state.phase === 'calling' && <p class="what">Snrdlephoning…</p>}
      {state.phase === 'ringing' && <p class="what">{state.from ? 'is snrdlephoning you' : 'is snrdlephoning you · connecting…'}</p>}
      {state.phase === 'talking' && (
        <p class="what">
          <Elapsed since={state.since} />
          {state.muted && ' · muted'}
        </p>
      )}
      <div class="buttons">
        {state.phase === 'ringing' ? (
          <>
            <button type="button" class="decline" onClick={calling.decline}>
              Decline
            </button>
            <button type="button" class="answer" onClick={calling.answer} disabled={!state.from}>
              Answer
            </button>
          </>
        ) : (
          <>
            {state.phase === 'talking' && (
              <button type="button" class="mute" aria-pressed={state.muted} onClick={() => calling.mute(!state.muted)}>
                {state.muted ? 'Unmute' : 'Mute'}
              </button>
            )}
            <button type="button" class="hang-up" onClick={calling.hangUp}>
              Hang up
            </button>
          </>
        )}
      </div>
    </div>
  )
}
