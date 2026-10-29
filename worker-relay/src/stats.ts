import type {IncomingKind} from './relay'

// Counts for the developers' dashboard: how much the relay is used, never by whom.
//
// Each day has a handful of totals (connections, messages stored, notifications sent). Nothing in them
// names a person, a device or a chat, and nothing is kept that would let one be picked out later. The
// figures that describe the present (devices with notifications on, messages held) are counted from
// what the relay holds anyway, when asked.

/** The parts of the Durable Object's SQLite database that are used here. */
export type Sql = {exec: (query: string, ...values: (string | number)[]) => {toArray: () => Record<string, string | number | null>[]}; databaseSize: number}

/** What is counted each day. */
export type Counter =
  /** WebSocket connections accepted. */
  | 'connections'
  /** Connections turned away because the relay was full or one address had too many. */
  | 'refused'
  /** Sealed messages newly stored, and their size. */
  | 'stored'
  | 'stored_bytes'
  /** Pushes accepted by a push service; refused for good (the device is forgotten); failed this time. */
  | 'push_sent'
  | 'push_gone'
  | 'push_failed'
  /** Messages devices send the relay, by kind (relay.ts). */
  | IncomingKind

/**
 * Incoming messages are counted in memory and written now and then, since writing a row for each would
 * itself cost thousands of writes a day. When the relay sleeps between messages the unwritten ones are
 * lost, so these counts run a little low; they are for proportions.
 */
const FLUSH_AFTER = 25
const FLUSH_EVERY_MS = 10 * 60_000

/** Daily totals are kept this long. */
export const KEEP_DAYS = 400

export type Stats = {
  /** One row per day and counter that is not zero, oldest first. */
  days: {day: string; counter: Counter; count: number}[]
  now: {
    /** Devices that have asked to be woken by notifications, and have renewed that in the last 60 days. */
    devicesWithNotifications: number
    /** Chats that at least one device wants notifications for. */
    chatsWithNotifications: number
    /** Sealed messages held, how many chats they belong to, and their size. */
    storedMessages: number
    chatsWithStoredMessages: number
    storedBytes: number
    /** The whole database, as Cloudflare bills it. */
    databaseBytes: number
    /** Connections open at this moment, live or not: each copy of the app holds two, a sleeping phone's linger. */
    connected: number
    /** The addresses those come from: about one per household, network or phone on mobile data. */
    addresses: number
    /** Of those connections, how many sent anything in the last ACTIVE_MS: about one per app open now. */
    active: number
    at: number
  }
}

const day = (at: number) => new Date(at).toISOString().slice(0, 10)

export function sqlStats(sql: Sql, now: () => number = Date.now) {
  sql.exec('CREATE TABLE IF NOT EXISTS daily (day TEXT NOT NULL, counter TEXT NOT NULL, count INTEGER NOT NULL, PRIMARY KEY (day, counter))')
  const hasTable = (name: string) => sql.exec("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?", name).toArray().length > 0
  const one = (query: string) => Number(Object.values(sql.exec(query).toArray()[0] ?? {})[0] ?? 0)
  const count = (counter: Counter, by = 1) => {
    if (by <= 0) return
    sql.exec('INSERT INTO daily (day, counter, count) VALUES (?, ?, ?) ON CONFLICT (day, counter) DO UPDATE SET count = count + excluded.count', day(now()), counter, by)
  }
  const pending = new Map<Counter, number>()
  let held = 0
  let flushedAt = now()
  const flush = () => {
    for (const [counter, by] of pending) count(counter, by)
    pending.clear()
    held = 0
    flushedAt = now()
  }
  return {
    count,
    /** Counts one, to be written with others later. */
    tally(counter: Counter) {
      pending.set(counter, (pending.get(counter) ?? 0) + 1)
      if (++held >= FLUSH_AFTER || now() - flushedAt >= FLUSH_EVERY_MS) flush()
    },
    flush,
    /** Drops totals older than KEEP_DAYS. */
    trim() {
      sql.exec('DELETE FROM daily WHERE day < ?', day(now() - KEEP_DAYS * 86400_000))
    },
    read({open, addresses, active}: {open: number; addresses: number; active: number}, sinceDays = 90): Stats {
      flush()
      const days = sql
        .exec('SELECT day, counter, count FROM daily WHERE day >= ? ORDER BY day, counter', day(now() - sinceDays * 86400_000))
        .toArray() as Stats['days']
      const pushes = hasTable('push_targets')
      const events = hasTable('events')
      return {
        days,
        now: {
          devicesWithNotifications: pushes ? one('SELECT COUNT(*) FROM push_targets') : 0,
          chatsWithNotifications: pushes ? one('SELECT COUNT(DISTINCT topic) FROM push_topics') : 0,
          storedMessages: events ? one('SELECT COUNT(*) FROM events') : 0,
          chatsWithStoredMessages: events ? one('SELECT COUNT(DISTINCT topic) FROM events') : 0,
          storedBytes: events ? one('SELECT COALESCE(SUM(bytes), 0) FROM events') : 0,
          databaseBytes: sql.databaseSize,
          connected: open,
          addresses,
          active,
          at: now()
        }
      }
    }
  }
}

export type RelayStats = ReturnType<typeof sqlStats>
