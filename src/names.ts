export const DEFAULT_CHAT_NAME = 'Chat'

/** Returns `wanted`, or `wanted 2`, `wanted 3`… if that name is already in use (ignoring case). */
export function uniqueChatName(wanted: string, taken: string[]): string {
  const used = new Set(taken.map(name => name.toLowerCase()))
  if (!used.has(wanted.toLowerCase())) return wanted
  for (let n = 2; ; n++) {
    const candidate = `${wanted} ${n}`
    if (!used.has(candidate.toLowerCase())) return candidate
  }
}
