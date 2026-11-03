// Snrdlephoning: voice calls in a direct chat, phone to phone.
//
// The sound goes over the chat's own WebRTC connection, which only verified members reach, encrypted
// end to end by DTLS-SRTP; neither relay nor TURN can hear it. What the devices say to each other about
// a call (ringing, answering, hanging up) goes the same way and is never stored. The caller also records
// the call in the chat's log, once as it starts ringing, which is left with the relay and wakes the other
// person's devices (push-tag.ts, the relay's `r` tag), and once as it ends, with how long it lasted.
//
// Every device of the person called rings. The first to answer gets the call, and the caller tells the
// others it was taken. Devices of the caller's own never ring.
import {toHex} from './bytes'
import {CALL_ID_BYTES, MAX_CALL_SECONDS, RING_MS, type CallContent} from './envelope'
import type {CallSignal, CallWire} from './session'
import type {MessageRecord} from './store'

/** How often a call rings their devices again while it is not answered, in case one did not hear. */
const RE_RING_MS = 3000

/** A call as the log tells it: when it rang, and how it ended if it has. */
export type LoggedCall = {id: string; caller: string; rangAt: number; seconds?: number}

/** Every call in a chat's log, in the order they rang. */
export function loggedCalls(messages: MessageRecord[]): LoggedCall[] {
  const calls = new Map<string, LoggedCall>()
  for (const {author, sentAt, content} of messages) {
    if (content.type !== 'call') continue
    // Only the caller records a call; anything else claiming to be about it is ignored.
    const known = calls.get(content.id)
    if (known && known.caller !== author) continue
    if (content.phase === 'ring') calls.set(content.id, {...known, id: content.id, caller: author, rangAt: known?.rangAt ?? sentAt})
    else calls.set(content.id, {id: content.id, caller: author, rangAt: known?.rangAt ?? sentAt, seconds: content.seconds ?? 0})
  }
  return [...calls.values()]
}

/** A call by someone else that rang just now and has not ended: the one to ring for, if any. */
export function ringingCall(messages: MessageRecord[], selfId: string, now = Date.now()): LoggedCall | null {
  return loggedCalls(messages).findLast(call => call.caller !== selfId && call.seconds === undefined && now - call.rangAt < RING_MS) ?? null
}

/** How long a call lasted, as a person would say it: "45 sec", "4 min", "1 hr 5 min". */
export function callLength(seconds: number): string {
  if (seconds < 60) return `${seconds} sec`
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return `${minutes} min`
  return `${Math.floor(minutes / 60)} hr${minutes % 60 ? ` ${minutes % 60} min` : ''}`
}

/** The line a call gets in the chat, by its caller and how it went. */
export function callLine(call: LoggedCall, mine: boolean, otherName: string, now = Date.now()): string | null {
  // Still ringing, or recorded as ringing by a caller who never said how it ended.
  if (call.seconds === undefined && now - call.rangAt < RING_MS) return null
  const seconds = call.seconds ?? 0
  if (seconds > 0) return `${mine ? `You snrdlephoned ${otherName}` : `${otherName} snrdlephoned you`} · ${callLength(seconds)}`
  return mine ? `You snrdlephoned ${otherName} · no answer` : `Missed snrdlephone call from ${otherName}`
}

/** What a call is doing, as the screen shows it. */
export type CallState =
  | {phase: 'idle'}
  /** We are ringing them. */
  | {phase: 'calling'; id: string}
  /**
   * They are ringing us; `from` is their device, once it has reached us directly. Answered before it
   * has (`answering`), the call is taken up as soon as it does.
   */
  | {phase: 'ringing'; id: string; from: string | null; answering: boolean}
  /** Talking: since when, to which of their devices, and whether we made the call. */
  | {phase: 'talking'; id: string; peer: string; since: number; muted: boolean; mine: boolean}

/** Why a call stopped, said once on screen. */
export type CallEnd = 'no answer' | 'declined' | 'ended' | 'taken' | 'lost' | 'no microphone'

export type CallOptions = {
  selfId: string
  /** The other person in the direct chat. */
  otherId: string
  /** The connection's call parts, as they are now; null while not connected. */
  wire: () => CallWire | null
  /** Devices connected now, verified as members. */
  peers: () => string[]
  post: (content: CallContent) => Promise<void>
  /** Asks for the microphone; must be called straight from a tap. */
  microphone: () => Promise<MediaStream>
  onState: (state: CallState) => void
  /** Their microphone, to play, or null once the call is over. */
  onSound: (stream: MediaStream | null) => void
  onEnd: (why: CallEnd) => void
  now?: () => number
}

export type Call = {
  /** Rings the other person. Call from a tap. */
  start: () => Promise<void>
  /** Answers the call ringing here. Call from a tap. */
  answer: () => Promise<void>
  decline: () => void
  hangUp: () => void
  mute: (muted: boolean) => void
  /** Pass on what a device of theirs said, and the chat's messages and connections as they change. */
  heard: (signal: CallSignal, peerId: string) => void
  stream: (stream: MediaStream, peerId: string) => void
  messages: (messages: MessageRecord[]) => void
  peersChanged: () => void
  /** Hangs up whatever is going on, as the chat closes. */
  close: () => void
}

export function makeCall(options: CallOptions): Call {
  const {selfId, otherId} = options
  const now = options.now ?? Date.now
  let state: CallState = {phase: 'idle'}
  let mic: MediaStream | null = null
  let timer: ReturnType<typeof setTimeout> | undefined
  let ringer: ReturnType<typeof setInterval> | undefined
  // Calls already rung here, or answered or turned down: the log does not start them ringing again.
  const done = new Set<string>()
  // Their devices already rung for the call we are making.
  const rung = new Set<string>()
  // Their microphone, if it arrived before the call was answered on either side.
  let early: {stream: MediaStream; peerId: string} | null = null

  const set = (next: CallState) => options.onState((state = next))
  const theirs = () => options.peers().filter(peerId => options.wire()?.memberOf(peerId) === otherId)
  const tell = (say: CallSignal['say'], id: string, peerId: string) => void options.wire()?.signal({id, say}, peerId).catch(() => {})

  function release() {
    clearTimeout(timer)
    clearInterval(ringer)
    const wire = options.wire()
    if (mic && state.phase === 'talking') wire?.removeStream(mic, state.peer)
    mic?.getTracks().forEach(track => track.stop())
    mic = null
    early = null
    rung.clear()
    options.onSound(null)
  }

  /** Ends the call here; the caller records how it went. */
  function finish(why: CallEnd) {
    if (state.phase === 'idle') return
    const {id} = state
    const mine = state.phase === 'calling' || (state.phase === 'talking' && state.mine)
    const seconds = state.phase === 'talking' ? Math.min(MAX_CALL_SECONDS, Math.max(1, Math.round((now() - state.since) / 1000))) : 0
    done.add(id)
    release()
    set({phase: 'idle'})
    if (mine) void options.post({type: 'call', id, phase: 'end', seconds}).catch(() => {})
    options.onEnd(why)
  }

  /** Rings each of their devices that is connected, again every few seconds in case one did not hear. */
  function ringTheirs() {
    if (state.phase !== 'calling') return
    for (const peerId of theirs()) {
      rung.add(peerId)
      tell('ring', state.id, peerId)
    }
  }

  /** Stops ringing here, without a word to the caller. */
  function stopRinging() {
    release()
    set({phase: 'idle'})
  }

  /** Takes up the call from their device, the microphone already in hand. */
  function pickUp(id: string, from: string) {
    if (!mic) return
    clearTimeout(timer)
    set({phase: 'talking', id, peer: from, since: now(), muted: false, mine: false})
    tell('answer', id, from)
    options.wire()?.addStream(mic, from)
    if (early?.peerId === from) options.onSound(early.stream)
    early = null
  }

  const call: Call = {
    async start() {
      if (state.phase !== 'idle') return
      try {
        mic = await options.microphone()
      } catch {
        options.onEnd('no microphone')
        return
      }
      const id = toHex(crypto.getRandomValues(new Uint8Array(CALL_ID_BYTES)))
      done.add(id)
      set({phase: 'calling', id})
      timer = setTimeout(() => state.phase === 'calling' && finish('no answer'), RING_MS)
      // Recorded first: that is what wakes their devices that are not connected.
      await options.post({type: 'call', id, phase: 'ring'}).catch(() => {})
      ringTheirs()
      ringer = setInterval(ringTheirs, RE_RING_MS)
    },

    async answer() {
      if (state.phase !== 'ringing' || state.answering) return
      const {id} = state
      // Asked for at once, while this is still a tap, even if their device has not reached us yet.
      set({...state, answering: true})
      try {
        mic = await options.microphone()
      } catch {
        if (state.phase === 'ringing' && state.from) tell('decline', id, state.from)
        done.add(id)
        stopRinging()
        options.onEnd('no microphone')
        return
      }
      if (state.phase !== 'ringing' || state.id !== id) return void release()
      if (state.from) pickUp(id, state.from)
    },

    decline() {
      if (state.phase !== 'ringing') return
      if (state.from) tell('decline', state.id, state.from)
      done.add(state.id)
      stopRinging()
    },

    hangUp() {
      if (state.phase === 'calling') {
        for (const peerId of rung) tell('end', state.id, peerId)
        finish('ended')
      } else if (state.phase === 'talking') {
        tell('end', state.id, state.peer)
        finish('ended')
      }
    },

    mute(muted) {
      if (state.phase !== 'talking') return
      mic?.getAudioTracks().forEach(track => (track.enabled = !muted))
      set({...state, muted})
    },

    heard(signal, peerId) {
      const member = options.wire()?.memberOf(peerId)
      if (member !== otherId) return
      const {id, say} = signal
      if (say === 'ring') {
        if (state.phase === 'ringing' && state.id === id && !state.from) {
          set({...state, from: peerId})
          if (state.answering && mic) pickUp(id, peerId)
        } else if (state.phase === 'idle' && !done.has(id)) {
          done.add(id)
          set({phase: 'ringing', id, from: peerId, answering: false})
          timer = setTimeout(() => state.phase === 'ringing' && state.id === id && (stopRinging(), options.onEnd('no answer')), RING_MS)
        }
      } else if (say === 'answer') {
        if (state.phase === 'calling' && state.id === id && mic) {
          clearTimeout(timer)
          set({phase: 'talking', id, peer: peerId, since: now(), muted: false, mine: true})
          options.wire()?.addStream(mic, peerId)
          if (early?.peerId === peerId) options.onSound(early.stream)
          early = null
          // The others of theirs that rang stop.
          for (const other of rung) if (other !== peerId) tell('taken', id, other)
        } else if (state.phase === 'talking' && state.id === id && state.peer !== peerId) tell('taken', id, peerId)
      } else if (say === 'decline') {
        // Turned down on one of their devices: the call is over, and the others stop ringing.
        if (state.phase === 'calling' && state.id === id) {
          for (const other of rung) if (other !== peerId) tell('end', id, other)
          finish('declined')
        }
      } else if (say === 'taken' || say === 'end') {
        if (state.phase === 'ringing' && state.id === id) {
          stopRinging()
          if (say === 'taken') options.onEnd('taken')
        } else if (state.phase === 'talking' && state.id === id && state.peer === peerId) finish('ended')
      }
    },

    stream(stream, peerId) {
      if (state.phase === 'talking' && state.peer === peerId) options.onSound(stream)
      // Sent as they answered, a moment before saying so.
      else if (state.phase === 'calling' || state.phase === 'ringing') early = {stream, peerId}
      else stream.getTracks().forEach(track => track.stop())
    },

    messages(messages) {
      // A call that rang while this device was asleep: woken by it, ring here until their device reaches us.
      const ringing = ringingCall(messages, selfId, now())
      if (ringing && ringing.caller === otherId && state.phase === 'idle' && !done.has(ringing.id)) {
        done.add(ringing.id)
        set({phase: 'ringing', id: ringing.id, from: null, answering: false})
        timer = setTimeout(() => state.phase === 'ringing' && state.id === ringing.id && (stopRinging(), options.onEnd('no answer')), Math.max(0, ringing.rangAt + RING_MS - now()))
      }
      // Ended by the caller before anyone answered here.
      if (state.phase === 'ringing') {
        const {id} = state
        if (loggedCalls(messages).some(call => call.id === id && call.seconds !== undefined)) stopRinging()
      }
    },

    peersChanged() {
      ringTheirs()
      // The device we were talking to has gone.
      if (state.phase === 'talking' && !options.peers().includes(state.peer)) finish('lost')
      if (state.phase === 'ringing' && state.from && !options.peers().includes(state.from)) set({...state, from: null})
    },

    close() {
      if (state.phase === 'calling' || state.phase === 'talking') call.hangUp()
      else if (state.phase === 'ringing') call.decline()
    }
  }
  return call
}
