// Message times as shown in the chat. All in the device's own time zone and locale.

const isValid = (timestamp: number) => Number.isFinite(new Date(timestamp).getTime())

const startOfDay = (timestamp: number) => {
  const date = new Date(timestamp)
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime()
}

/** Identifies the local calendar day a message belongs to, for grouping. */
export function dayKey(timestamp: number): string {
  if (!isValid(timestamp)) return ''
  const date = new Date(timestamp)
  return `${date.getFullYear()}-${date.getMonth() + 1}-${date.getDate()}`
}

export function formatTime(timestamp: number, locale?: string): string {
  if (!isValid(timestamp)) return ''
  return new Intl.DateTimeFormat(locale, {hour: 'numeric', minute: '2-digit'}).format(timestamp)
}

/** "Today", "Yesterday", or a date, with the year only when it is not the current one. */
export function formatDay(timestamp: number, now = Date.now(), locale?: string): string {
  if (!isValid(timestamp)) return ''
  const daysAgo = Math.round((startOfDay(now) - startOfDay(timestamp)) / 86_400_000)
  if (daysAgo === 0) return 'Today'
  if (daysAgo === 1) return 'Yesterday'
  const sameYear = new Date(timestamp).getFullYear() === new Date(now).getFullYear()
  return new Intl.DateTimeFormat(locale, {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    ...(sameYear ? {} : {year: 'numeric'})
  }).format(timestamp)
}

/** When a chat last had a message, as its row in the list says it: "9:05 PM", "Yesterday", "Tue", "3 Nov". */
export function formatWhen(timestamp: number, now = Date.now(), locale?: string): string {
  if (!isValid(timestamp)) return ''
  const daysAgo = Math.round((startOfDay(now) - startOfDay(timestamp)) / 86_400_000)
  if (daysAgo <= 0) return formatTime(timestamp, locale)
  if (daysAgo === 1) return 'Yesterday'
  if (daysAgo < 7) return new Intl.DateTimeFormat(locale, {weekday: 'short'}).format(timestamp)
  const sameYear = new Date(timestamp).getFullYear() === new Date(now).getFullYear()
  return new Intl.DateTimeFormat(locale, {day: 'numeric', month: 'short', ...(sameYear ? {} : {year: 'numeric'})}).format(timestamp)
}

/**
 * A message's time, saying the day too once it is not today, so that scrolling back through a chat
 * never makes an old message look new: "9:05 PM", "Yesterday 9:05 PM", "Mon 9:05 PM", "Oct 30, 9:05 PM".
 */
export function formatStamp(timestamp: number, now = Date.now(), locale?: string): string {
  const time = formatTime(timestamp, locale)
  if (!time) return ''
  const daysAgo = Math.round((startOfDay(now) - startOfDay(timestamp)) / 86_400_000)
  if (daysAgo <= 0) return time
  if (daysAgo < 7) return `${formatWhen(timestamp, now, locale)} ${time}`
  return `${formatWhen(timestamp, now, locale)}, ${time}`
}
