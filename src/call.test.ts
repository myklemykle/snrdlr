import {describe, expect, it, vi} from 'vitest'
import {callLength, callLine, loggedCalls, makeCall, ringingCall, type Call, type CallEnd, type CallState} from './call'
import type {CallContent} from './envelope'
import type {CallWire} from './session'
import type {MessageRecord} from './store'

const ANNE = 'a'.repeat(64)
const BOB = 'b'.repeat(64)

const record = (author: string, sentAt: number, content: CallContent, seq = 1): MessageRecord =>
  ({chatId: 'c', author, device: '', seq, lamport: seq, sentAt, receivedAt: sentAt, content, envelope: new Uint8Array()}) as MessageRecord

/** A stand-in for a microphone: tracks that can be stopped and muted. */
function fakeMic() {
  const track = {enabled: true, stopped: false, stop: () => void (track.stopped = true)}
  return {track, stream: {getTracks: () => [track], getAudioTracks: () => [track]} as unknown as MediaStream}
}

/**
 * Anne's one device ('anne') and Bob's two ('phone', 'laptop'), connected to each other, each with a
 * call of its own. What one device says reaches the other straight away, as over a connection.
 */
function threeDevices() {
  const owner: Record<string, string> = {anne: ANNE, phone: BOB, laptop: BOB}
  const devices: Record<string, {call: Call; states: CallState[]; ends: CallEnd[]; sounds: (MediaStream | null)[]; posted: CallContent[]; mic: ReturnType<typeof fakeMic>}> = {}
  let connected = ['anne', 'phone', 'laptop']
  for (const name of Object.keys(owner)) {
    const self = owner[name]
    const mic = fakeMic()
    const wire: CallWire = {
      signal: async (signal, peerId) => devices[peerId].call.heard(signal, name),
      addStream: (stream, peerId) => devices[peerId].call.stream(stream, name),
      removeStream: () => {},
      memberOf: peerId => owner[peerId] ?? null
    }
    const entry = {states: [] as CallState[], ends: [] as CallEnd[], sounds: [] as (MediaStream | null)[], posted: [] as CallContent[], mic} as (typeof devices)[string]
    entry.call = makeCall({
      selfId: self,
      otherId: self === ANNE ? BOB : ANNE,
      wire: () => (connected.includes(name) ? wire : null),
      peers: () => connected.filter(peer => peer !== name && connected.includes(name)),
      post: async content => void entry.posted.push(content),
      microphone: async () => mic.stream,
      onState: state => void entry.states.push(state),
      onSound: stream => void entry.sounds.push(stream),
      onEnd: why => void entry.ends.push(why)
    })
    devices[name] = entry
  }
  const phase = (name: string) => devices[name].states.at(-1)?.phase ?? 'idle'
  const leave = (name: string) => {
    connected = connected.filter(peer => peer !== name)
    Object.values(devices).forEach(device => device.call.peersChanged())
  }
  return {devices, phase, leave}
}

describe('snrdlephoning', () => {
  it('rings every device of the other person, connects the first to answer, and stops the rest', async () => {
    const {devices, phase} = threeDevices()
    await devices.anne.call.start()
    expect(devices.anne.posted).toEqual([expect.objectContaining({phase: 'ring'})])
    expect([phase('anne'), phase('phone'), phase('laptop')]).toEqual(['calling', 'ringing', 'ringing'])

    await devices.phone.call.answer()
    expect([phase('anne'), phase('phone'), phase('laptop')]).toEqual(['talking', 'talking', 'idle'])
    expect(devices.laptop.ends).toEqual(['taken'])
    // Each hears the other's microphone.
    expect(devices.anne.sounds.at(-1)).toBe(devices.phone.mic.stream)
    expect(devices.phone.sounds.at(-1)).toBe(devices.anne.mic.stream)

    // Bob hangs up; Anne, who called, records how long it was.
    devices.phone.call.hangUp()
    expect([phase('anne'), phase('phone')]).toEqual(['idle', 'idle'])
    expect(devices.anne.posted.at(-1)).toEqual(expect.objectContaining({phase: 'end', seconds: expect.any(Number)}))
    expect(devices.phone.posted).toEqual([])
    expect(devices.anne.mic.track.stopped && devices.phone.mic.track.stopped).toBe(true)
    expect(devices.anne.sounds.at(-1)).toBeNull()
  })

  it('ends for everyone when turned down on one device, and records it as unanswered', async () => {
    const {devices, phase} = threeDevices()
    await devices.anne.call.start()
    devices.laptop.call.decline()
    expect([phase('anne'), phase('phone'), phase('laptop')]).toEqual(['idle', 'idle', 'idle'])
    expect(devices.anne.ends).toEqual(['declined'])
    expect(devices.anne.posted.at(-1)).toEqual(expect.objectContaining({phase: 'end', seconds: 0}))
  })

  it('gives up after ringing a while with no answer', async () => {
    vi.useFakeTimers()
    try {
      const {devices, phase} = threeDevices()
      await devices.anne.call.start()
      vi.advanceTimersByTime(46_000)
      expect([phase('anne'), phase('phone'), phase('laptop')]).toEqual(['idle', 'idle', 'idle'])
      expect(devices.anne.ends).toEqual(['no answer'])
      expect(devices.anne.posted.at(-1)).toEqual(expect.objectContaining({phase: 'end', seconds: 0}))
    } finally {
      vi.useRealTimers()
    }
  })

  it('mutes, and ends when the device on the other end goes away', async () => {
    const {devices, phase, leave} = threeDevices()
    await devices.anne.call.start()
    await devices.laptop.call.answer()
    devices.anne.call.mute(true)
    expect(devices.anne.mic.track.enabled).toBe(false)
    expect(devices.anne.states.at(-1)).toEqual(expect.objectContaining({phase: 'talking', muted: true}))
    leave('laptop')
    expect(phase('anne')).toBe('idle')
    expect(devices.anne.ends).toEqual(['lost'])
  })

  it('rings a device woken by the call, once its caller reaches it, and never for our own calls', () => {
    const {devices, phase} = threeDevices()
    const ring = record(ANNE, Date.now(), {type: 'call', id: '0123456789abcdef', phase: 'ring'})
    devices.phone.call.messages([ring])
    expect(devices.phone.states.at(-1)).toEqual({phase: 'ringing', id: '0123456789abcdef', from: null, answering: false})
    // Seen again, it does not start over; ended by the caller, it stops.
    devices.phone.call.messages([ring, record(ANNE, Date.now(), {type: 'call', id: '0123456789abcdef', phase: 'end', seconds: 0}, 2)])
    expect(phase('phone')).toBe('idle')
    // Anne's own call, seen on her device, does not ring there.
    devices.anne.call.messages([ring])
    expect(phase('anne')).toBe('idle')
    // Nor does one that rang long ago.
    devices.laptop.call.messages([record(ANNE, Date.now() - 60_000, {type: 'call', id: '1123456789abcdef', phase: 'ring'})])
    expect(phase('laptop')).toBe('idle')
  })

  it('takes an answer before the caller has reached this device, and connects once it does', async () => {
    const {devices, phase} = threeDevices()
    const id = '0123456789abcdef'
    devices.phone.call.messages([record(ANNE, Date.now(), {type: 'call', id, phase: 'ring'})])
    await devices.phone.call.answer()
    expect(devices.phone.states.at(-1)).toEqual(expect.objectContaining({phase: 'ringing', answering: true, from: null}))
    // Anne's device, which is calling, reaches the phone.
    devices.phone.call.heard({id, say: 'ring'}, 'anne')
    expect(phase('phone')).toBe('talking')
  })

  it('reads calls from the log and words them for the chat', () => {
    const now = Date.now()
    const messages = [
      record(ANNE, now - 600_000, {type: 'call', id: '0000000000000001', phase: 'ring'}, 1),
      record(ANNE, now - 360_000, {type: 'call', id: '0000000000000001', phase: 'end', seconds: 240}, 2),
      // Bob cannot end Anne's call.
      record(BOB, now - 300_000, {type: 'call', id: '0000000000000002', phase: 'ring'}, 1),
      record(ANNE, now - 290_000, {type: 'call', id: '0000000000000002', phase: 'end', seconds: 999}, 3),
      record(BOB, now - 1000, {type: 'call', id: '0000000000000003', phase: 'ring'}, 2)
    ]
    const calls = loggedCalls(messages)
    expect(calls.map(call => [call.caller === ANNE ? 'anne' : 'bob', call.seconds])).toEqual([['anne', 240], ['bob', undefined], ['bob', undefined]])
    expect(callLine(calls[0], true, 'Bob', now)).toBe('You snrdlephoned Bob · 4 min')
    expect(callLine(calls[0], false, 'Anne', now)).toBe('Anne snrdlephoned you · 4 min')
    // Rang and never said how it ended: missed.
    expect(callLine(calls[1], false, 'Bob', now)).toBe('Missed snrdlephone call from Bob')
    expect(callLine(calls[1], true, 'Anne', now)).toBe('You snrdlephoned Anne · no answer')
    // Still ringing: no line yet, and it is the one ringing for Anne.
    expect(callLine(calls[2], false, 'Bob', now)).toBeNull()
    expect(ringingCall(messages, ANNE, now)?.id).toBe('0000000000000003')
    expect(ringingCall(messages, BOB, now)).toBeNull()
    expect([callLength(45), callLength(240), callLength(3900)]).toEqual(['45 sec', '4 min', '1 hr 5 min'])
  })
})
