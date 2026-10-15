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
    /** Devices connected at this moment. */
    connected: number
    at: number
  }
}

const day = (at: number) => new Date(at).toISOString().slice(0, 10)

export function sqlStats(sql: Sql, now: () => number = Date.now) {
  sql.exec('CREATE TABLE IF NOT EXISTS daily (day TEXT NOT NULL, counter TEXT NOT NULL, count INTEGER NOT NULL, PRIMARY KEY (day, counter))')
  const hasTable = (name: string) => sql.exec("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?", name).toArray().length > 0
  const one = (query: string) => Number(Object.values(sql.exec(query).toArray()[0] ?? {})[0] ?? 0)
  return {
    count(counter: Counter, by = 1) {
      if (by <= 0) return
      sql.exec('INSERT INTO daily (day, counter, count) VALUES (?, ?, ?) ON CONFLICT (day, counter) DO UPDATE SET count = count + excluded.count', day(now()), counter, by)
    },
    /** Drops totals older than KEEP_DAYS. */
    trim() {
      sql.exec('DELETE FROM daily WHERE day < ?', day(now() - KEEP_DAYS * 86400_000))
    },
    read(connected: number, sinceDays = 90): Stats {
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
          connected,
          at: now()
        }
      }
    }
  }
}

export type RelayStats = ReturnType<typeof sqlStats>
