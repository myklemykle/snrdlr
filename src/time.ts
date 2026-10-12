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
