import {describe, expect, it} from 'vitest'
import {dayKey, formatDay, formatStamp, formatTime, formatWhen} from './time'

// Built from local-time parts, so the tests hold in any time zone.
const at = (year: number, month: number, day: number, hour = 12, minute = 0) => new Date(year, month - 1, day, hour, minute).getTime()
const now = at(2026, 10, 11, 15, 30)

describe('formatDay', () => {
  it('names today and yesterday, whatever the time of day', () => {
    expect(formatDay(at(2026, 10, 11, 0, 1), now)).toBe('Today')
    expect(formatDay(at(2026, 10, 11, 23, 59), now)).toBe('Today')
    expect(formatDay(at(2026, 10, 10, 23, 59), now)).toBe('Yesterday')
    expect(formatDay(at(2026, 10, 10, 0, 1), now)).toBe('Yesterday')
  })

  it('gives a date for older days, adding the year only when it differs', () => {
    expect(formatDay(at(2026, 10, 9), now, 'en-US')).toBe('Fri, Oct 9')
    expect(formatDay(at(2025, 12, 31), now, 'en-US')).toBe('Wed, Dec 31, 2025')
  })

  it('counts calendar days across a clock change', () => {
    // 25 October 2026 is 25 hours long where summer time ends that day.
    expect(formatDay(at(2026, 10, 25, 12), at(2026, 10, 26, 0, 30))).toBe('Yesterday')
  })
})

describe('dayKey', () => {
  it('is the same for any two moments of one local day, and differs across midnight', () => {
    expect(dayKey(at(2026, 10, 11, 0, 0))).toBe(dayKey(at(2026, 10, 11, 23, 59)))
    expect(dayKey(at(2026, 10, 11, 23, 59))).not.toBe(dayKey(at(2026, 10, 12, 0, 0)))
  })
})

describe('formatTime', () => {
  it('shows hours and minutes', () => {
    expect(formatTime(at(2026, 10, 11, 9, 5), 'en-GB')).toMatch(/^0?9:05$/)
    expect(formatTime(at(2026, 10, 11, 21, 5), 'en-US')).toMatch(/^9:05\sPM$/)
  })

  it('shows nothing for a timestamp no calendar can represent', () => {
    // A member's device can claim any send time, including one past the end of the calendar.
    for (const format of [formatTime, formatDay, dayKey, formatWhen, formatStamp]) expect(format(Number.MAX_SAFE_INTEGER)).toBe('')
  })
})

describe('formatWhen', () => {
  const now = at(2026, 11, 6, 15, 0)
  it('shows the time today, then the day this past week, then the date', () => {
    expect(formatWhen(at(2026, 11, 6, 9, 5), now, 'en-US')).toMatch(/^9:05\sAM$/)
    expect(formatWhen(at(2026, 11, 5, 23, 0), now, 'en-US')).toBe('Yesterday')
    expect(formatWhen(at(2026, 11, 2, 12, 0), now, 'en-US')).toBe('Mon')
    expect(formatWhen(at(2026, 10, 30, 12, 0), now, 'en-US')).toBe('Oct 30')
    expect(formatWhen(at(2025, 12, 30, 12, 0), now, 'en-US')).toBe('Dec 30, 2025')
  })
})

describe('formatStamp', () => {
  const now = at(2026, 11, 6, 15, 0)
  it('gives the time alone today, and the day with it before', () => {
    expect(formatStamp(at(2026, 11, 6, 9, 5), now, 'en-US')).toMatch(/^9:05\sAM$/)
    expect(formatStamp(at(2026, 11, 5, 21, 5), now, 'en-US')).toMatch(/^Yesterday 9:05\sPM$/)
    expect(formatStamp(at(2026, 11, 2, 9, 5), now, 'en-US')).toMatch(/^Mon 9:05\sAM$/)
    expect(formatStamp(at(2026, 10, 30, 9, 5), now, 'en-US')).toMatch(/^Oct 30, 9:05\sAM$/)
  })
})
