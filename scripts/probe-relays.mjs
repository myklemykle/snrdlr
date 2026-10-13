// Measures which public Nostr relays would carry the app's connection setup, so a list can be
// chosen from evidence. It does what one device pair does, once: a subscriber and a publisher
// connect, the publisher posts one short-lived event the size of a real handshake, and the
// probe times its arrival at the subscriber.
//
// It is deliberately light on other people's servers. Per relay, per run: one information
// request, two connections, one subscription, one event, then it hangs up. A relay is not
// probed again for hours (see `nextProbeAt`), less often once it fails, and never again once it
// has twice asked us to slow down. A relay that says it needs a login or payment is never
// connected to at all.
//
//   node scripts/probe-relays.mjs                 probe every relay that is due
//   node scripts/probe-relays.mjs --report        print the results table, scheduled runs included
//   --out <file>     results file, one JSON line per relay per run (default probe-data/results.jsonl)
//   --from <label>   where this run is made from, e.g. "home" or "github" (default "local")
//   --only <urls>    comma-separated relays instead of the candidate list
//   --dry-run        list what is due and why the rest is not, without connecting
import {execFileSync} from 'node:child_process'
import {appendFileSync, existsSync, mkdirSync, readFileSync} from 'node:fs'
import {dirname} from 'node:path'
import {fileURLToPath} from 'node:url'
import {schnorr} from '@noble/curves/secp256k1.js'
import {sha256} from '@noble/hashes/sha2.js'
import {bytesToHex, randomBytes} from '@noble/hashes/utils.js'
import WebSocket from 'ws'

export const USER_AGENT = 'snrdlr-relay-probe (+https://github.com/myklemykle/snrdlr)'

const HOUR = 3600_000
const DAY = 24 * HOUR
export const MIN_GAP_MS = 3 * HOUR

const INFO_TIMEOUT_MS = 5000
const CONNECT_TIMEOUT_MS = 8000
const EOSE_WAIT_MS = 3000
const DELIVERY_TIMEOUT_MS = 5000
// A real connection offer is one to three kilobytes once encrypted.
const CONTENT_BYTES = 2000
const AT_ONCE = 6

const limitedPattern = /rate.?limit|too many|slow down|too fast|blocked|banned|throttl/i

/** A signed short-lived event, shaped like the ones Trystero posts (kind 20000 to 29999, one "x" tag). */
export const makeEvent = (secretKey, {kind, topic, content, createdAt}) => {
  const pubkey = bytesToHex(schnorr.getPublicKey(secretKey))
  const tags = [['x', topic]]
  const id = sha256(new TextEncoder().encode(JSON.stringify([0, pubkey, createdAt, kind, tags, content])))
  return {kind, tags, created_at: createdAt, content, pubkey, id: bytesToHex(id), sig: bytesToHex(schnorr.sign(id, secretKey))}
}

const probeContent = () => {
  const label = 'snrdlr relay probe, see https://github.com/myklemykle/snrdlr '
  return label + Buffer.from(randomBytes(CONTENT_BYTES)).toString('base64').slice(0, CONTENT_BYTES - label.length)
}

/**
 * Reads the relay's own description (NIP-11) and returns why it could not serve us, if it says so.
 * Most failures here mean only that the relay publishes no description, which is fine.
 */
export const readInfo = async url => {
  const started = Date.now()
  try {
    const response = await fetch(url.replace(/^ws/, 'http'), {
      headers: {Accept: 'application/nostr+json', 'User-Agent': USER_AGENT},
      signal: AbortSignal.timeout(INFO_TIMEOUT_MS),
    })
    if (response.status === 429) return {infoMs: Date.now() - started, limited: 'information request answered 429'}
    if (!response.ok) return {infoMs: Date.now() - started}
    const info = await response.json()
    const limits = info.limitation ?? {}
    const barriers = []
    if (limits.auth_required) barriers.push('needs a login')
    if (limits.payment_required) barriers.push('needs payment')
    if (limits.restricted_writes) barriers.push('only some people may post')
    if (limits.min_pow_difficulty > 0) barriers.push(`needs proof of work (${limits.min_pow_difficulty})`)
    if (limits.max_content_length < CONTENT_BYTES) barriers.push(`content limited to ${limits.max_content_length}`)
    return {infoMs: Date.now() - started, software: shortSoftware(info), barriers}
  } catch {
    return {}
  }
}

const shortSoftware = info => {
  const name = String(info.software ?? '').replace(/^git\+/, '').replace(/\.git$/, '').split('/').pop()
  return [name, info.version].filter(Boolean).join(' ').slice(0, 60) || undefined
}

const connect = url =>
  new Promise((resolve, reject) => {
    const started = Date.now()
    const socket = new WebSocket(url, {headers: {'User-Agent': USER_AGENT}, handshakeTimeout: CONNECT_TIMEOUT_MS})
    socket.once('open', () => resolve({socket, ms: Date.now() - started}))
    socket.once('unexpected-response', (_request, response) => {
      socket.terminate()
      reject(Object.assign(new Error(`handshake answered ${response.statusCode}`), {status: response.statusCode}))
    })
    socket.once('error', reject)
  })

/** One measurement of one relay. Never throws; the outcome says what happened. */
export const probeRelay = async url => {
  const result = {url}
  const info = await readInfo(url)
  Object.assign(result, {infoMs: info.infoMs, software: info.software})
  if (info.limited) return {...result, outcome: 'limited', note: info.limited}
  if (info.barriers?.length) return {...result, outcome: 'ineligible', note: info.barriers.join(', ')}

  let subscriber
  let publisher
  try {
    ;[subscriber, publisher] = await Promise.all([connect(url), connect(url)])
  } catch (error) {
    subscriber?.socket.terminate()
    const refused = error.status === 429 || error.status === 403
    return {...result, outcome: refused ? 'limited' : 'unreachable', note: String(error.message ?? error).slice(0, 120)}
  }
  result.connectMs = Math.max(subscriber.ms, publisher.ms)

  const secretKey = schnorr.utils.randomSecretKey()
  const topic = bytesToHex(randomBytes(20))
  const kind = 20000 + Math.floor(Math.random() * 10000)
  const createdAt = Math.floor(Date.now() / 1000)
  const event = makeEvent(secretKey, {kind, topic, content: probeContent(), createdAt})
  const said = []
  let limited = false
  let authAsked = false
  let subscriptionClosed = false

  const listen = (socket, handlers) =>
    socket.on('message', raw => {
      let message
      try {
        message = JSON.parse(raw.toString())
      } catch {
        return
      }
      if (!Array.isArray(message)) return
      const [type, ...rest] = message
      if (type === 'NOTICE' || type === 'CLOSED') {
        const text = String(rest.at(-1) ?? '')
        said.push(`${type}: ${text}`.slice(0, 120))
        if (limitedPattern.test(text)) limited = true
      }
      if (type === 'AUTH') authAsked = true
      handlers[type]?.(...rest)
    })

  try {
    let arrived
    const delivery = new Promise(resolve => (arrived = resolve))
    const subscribed = new Promise(resolve => {
      listen(subscriber.socket, {
        EOSE: resolve,
        CLOSED: () => ((subscriptionClosed = true), resolve()),
        EVENT: (_subId, received) => {
          if (received?.id === event.id) arrived(Date.now())
        },
      })
      setTimeout(resolve, EOSE_WAIT_MS)
    })
    const accepted = new Promise(resolve =>
      listen(publisher.socket, {
        OK: (id, ok, reason) => {
          if (id === event.id) resolve({ok, reason: String(reason ?? '')})
        },
      }),
    )

    const subscribeStarted = Date.now()
    subscriber.socket.send(JSON.stringify(['REQ', 'probe', {kinds: [kind], since: createdAt, '#x': [topic]}]))
    await subscribed
    result.subscribeMs = Date.now() - subscribeStarted

    const sent = Date.now()
    publisher.socket.send(JSON.stringify(['EVENT', event]))
    const timeout = new Promise(resolve => setTimeout(resolve, DELIVERY_TIMEOUT_MS))
    // A refusal ends the wait early; an acceptance does not, since delivery is what counts.
    const refused = new Promise(resolve => accepted.then(verdict => verdict.ok === false && resolve()))
    const arrivedAt = await Promise.race([delivery, timeout, refused])
    // The relay's verdict usually lands with the delivery; give a refusal a moment to show up.
    const verdict = await Promise.race([accepted, new Promise(resolve => setTimeout(resolve, arrivedAt ? 300 : 0))])

    if (verdict && limitedPattern.test(verdict.reason)) limited = true
    if (verdict?.reason) said.push(`OK ${verdict.ok}: ${verdict.reason}`.slice(0, 120))
    if (arrivedAt) Object.assign(result, {outcome: 'ok', deliveryMs: arrivedAt - sent})
    else if (limited) result.outcome = 'limited'
    else if (verdict?.ok === false || authAsked || subscriptionClosed) result.outcome = 'rejected'
    else result.outcome = 'not-delivered'
    if (authAsked && !arrivedAt) said.push('asked for a login')
  } finally {
    if (subscriber.socket.readyState === WebSocket.OPEN) subscriber.socket.send(JSON.stringify(['CLOSE', 'probe']))
    subscriber.socket.close()
    publisher.socket.close()
    setTimeout(() => (subscriber.socket.terminate(), publisher.socket.terminate()), 1000).unref()
  }
  if (said.length) result.note = [...new Set(said)].join(' | ').slice(0, 300)
  return result
}

const isLocal = url => /^wss?:\/\/(localhost|127\.0\.0\.1)[:/]/.test(url)

/**
 * When a relay may next be probed, given everything recorded about it (oldest first).
 * Returns {at} or {never: reason}. This is the politeness rule; change it with care.
 */
export const nextProbeAt = (history, minGapMs = MIN_GAP_MS) => {
  const last = history.at(-1)
  if (!last) return {at: 0}
  let streak = 0
  for (let i = history.length - 1; i >= 0 && history[i].outcome === last.outcome; i--) streak++
  const after = gap => ({at: Date.parse(last.at) + gap})

  switch (last.outcome) {
    case 'limited':
      return streak >= 2 ? {never: 'asked us to slow down twice'} : after(DAY)
    case 'ineligible':
      return after(7 * DAY)
    case 'unreachable':
      if (streak >= 7) return {never: 'unreachable seven times running'}
      return after(streak >= 3 ? DAY : minGapMs)
    case 'rejected':
    case 'not-delivered':
      return after(streak >= 3 ? 7 * DAY : minGapMs)
    default:
      return after(minGapMs)
  }
}

export const readResults = file =>
  existsSync(file)
    ? readFileSync(file, 'utf8')
        .split('\n')
        .filter(Boolean)
        .map(line => JSON.parse(line))
    : []

const historyByRelay = results => {
  const byRelay = new Map()
  for (const entry of results) byRelay.set(entry.url, [...(byRelay.get(entry.url) ?? []), entry])
  return byRelay
}

const median = numbers => {
  const sorted = [...numbers].sort((a, b) => a - b)
  return sorted.length ? sorted[Math.floor((sorted.length - 1) / 2)] : undefined
}

/** One row per relay and vantage point, best first. */
export const summarize = results => {
  const rows = []
  const groups = new Map()
  for (const entry of results) {
    const key = `${entry.from}\n${entry.url}`
    groups.set(key, [...(groups.get(key) ?? []), entry])
  }
  for (const entries of groups.values()) {
    const delivered = entries.filter(entry => entry.outcome === 'ok')
    const times = delivered.map(entry => entry.deliveryMs)
    const last = entries.at(-1)
    rows.push({
      from: last.from,
      url: last.url,
      runs: entries.length,
      delivered: delivered.length,
      rate: delivered.length / entries.length,
      medianMs: median(times),
      worstMs: times.length ? Math.max(...times) : undefined,
      connectMs: median(entries.filter(entry => entry.connectMs).map(entry => entry.connectMs)),
      last: last.outcome,
      note: [...entries].reverse().find(entry => entry.note)?.note,
    })
  }
  return rows.sort((a, b) => a.from.localeCompare(b.from) || b.rate - a.rate || (a.medianMs ?? 1e9) - (b.medianMs ?? 1e9))
}

const loadCandidates = () => {
  const lists = JSON.parse(readFileSync(new URL('./relay-candidates.json', import.meta.url), 'utf8'))
  return {all: [...lists.ours, ...lists.current, ...lists.trystero, ...lists.known], current: new Set([...lists.ours, ...lists.current])}
}

const printReport = (results, current) => {
  const rows = summarize(results)
  if (!rows.length) return console.log('No results yet.')
  const cell = (value, width) => String(value ?? '-').padEnd(width)
  for (const from of new Set(rows.map(row => row.from))) {
    const mine = rows.filter(row => row.from === from)
    const dates = results.filter(entry => entry.from === from).map(entry => entry.at)
    console.log(`\nFrom "${from}": ${dates[0].slice(0, 16)} to ${dates.at(-1).slice(0, 16)} UTC   (* = used by the app today)\n`)
    console.log(`  ${cell('relay', 36)}${cell('delivered', 11)}${cell('median', 8)}${cell('worst', 8)}${cell('connect', 9)}last`)
    for (const row of mine) {
      const name = (current.has(row.url) ? '* ' : '  ') + row.url.replace('wss://', '')
      const ms = value => (value === undefined ? '-' : `${value}ms`)
      const last = row.last === 'ok' ? 'ok' : `${row.last}${row.note ? ` (${row.note.slice(0, 70)})` : ''}`
      console.log(`${cell(name, 38)}${cell(`${row.delivered}/${row.runs}`, 11)}${cell(ms(row.medianMs), 8)}${cell(ms(row.worstMs), 8)}${cell(ms(row.connectMs), 9)}${last}`)
    }
  }
}

/** Results from the scheduled runs, which live on the probe-data branch. Empty if it cannot be read. */
const scheduledResults = () => {
  try {
    const git = args => execFileSync('git', args, {encoding: 'utf8', timeout: 20_000, stdio: ['ignore', 'pipe', 'ignore']})
    git(['fetch', '-q', 'origin', 'probe-data'])
    return git(['show', 'FETCH_HEAD:results.jsonl'])
      .split('\n')
      .filter(Boolean)
      .map(line => JSON.parse(line))
  } catch {
    return []
  }
}

const option = (args, name) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined)

const main = async () => {
  const args = process.argv.slice(2)
  const out = option(args, '--out') ?? 'probe-data/results.jsonl'
  const from = option(args, '--from') ?? 'local'
  const candidates = loadCandidates()
  const results = readResults(out)

  if (args.includes('--report')) return printReport([...results, ...scheduledResults()], candidates.current)

  const urls = option(args, '--only')?.split(',').filter(Boolean) ?? candidates.all
  // The rule counts probes from anywhere this file knows about, not only this vantage point.
  const histories = historyByRelay(results)
  const now = Date.now()
  const due = []
  for (const url of urls) {
    const next = isLocal(url) ? {at: 0} : nextProbeAt(histories.get(url) ?? [])
    if (next.never) console.log(`skip  ${url}: retired, ${next.never}`)
    else if (next.at > now) console.log(`skip  ${url}: not due until ${new Date(next.at).toISOString().slice(0, 16)} UTC`)
    else due.push(url)
  }
  if (args.includes('--dry-run')) return console.log(`\n${due.length} due:\n${due.join('\n')}`)
  if (!due.length) return console.log('Nothing is due.')

  mkdirSync(dirname(out), {recursive: true})
  const queue = due.sort(() => Math.random() - 0.5)
  const worker = async () => {
    for (let url = queue.pop(); url; url = queue.pop()) {
      const result = await probeRelay(url)
      appendFileSync(out, JSON.stringify({at: new Date().toISOString(), from, ...result}) + '\n')
      const detail = result.outcome === 'ok' ? `${result.deliveryMs}ms` : (result.note ?? '')
      console.log(`${result.outcome.padEnd(14)}${url}  ${detail}`)
    }
  }
  await Promise.all(Array.from({length: AT_ONCE}, worker))
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await main()
