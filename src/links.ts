// Finds web addresses in message text, so they can be tapped. Only http and https addresses become
// links (and ones starting "www.", which are taken to be https); nothing else a message says can make
// the browser go anywhere.

export type Piece = {text: string; href?: string}

const FOUND = /\b(?:https?:\/\/|www\.)[^\s<>"]+/gi
// Punctuation that ends a sentence rather than an address.
const TRAILING = /[.,;:!?'"*_~]+$/

/** Leaves off what follows an address in ordinary writing: a full stop, or a bracket the address did not open. */
function trim(found: string): string {
  let text = found.replace(TRAILING, '')
  for (const [open, close] of [['(', ')'], ['[', ']'], ['{', '}']]) {
    while (text.endsWith(close) && text.split(close).length > text.split(open).length) text = text.slice(0, -1).replace(TRAILING, '')
  }
  return text
}

/** The text in pieces, each either plain or a link. */
export function findLinks(text: string): Piece[] {
  const pieces: Piece[] = []
  let at = 0
  for (const match of text.matchAll(FOUND)) {
    const found = trim(match[0])
    const start = match.index
    let href: string
    try {
      const url = new URL(/^www\./i.test(found) ? `https://${found}` : found)
      if ((url.protocol !== 'https:' && url.protocol !== 'http:') || !url.hostname.includes('.')) continue
      href = url.href
    } catch {
      continue
    }
    if (start > at) pieces.push({text: text.slice(at, start)})
    pieces.push({text: found, href})
    at = start + found.length
  }
  if (at < text.length) pieces.push({text: text.slice(at)})
  return pieces
}
