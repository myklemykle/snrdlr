import {DatabaseSync} from 'node:sqlite'
import {describe, expect, it} from 'vitest'
import {sqlPushes} from './index'
import {incomingKind} from './relay'
import {sqlStats, type Sql} from './stats'

/** Node's own SQLite, shaped like a Durable Object's. */
function memorySql(): Sql {
  const db = new DatabaseSync(':memory:')
  return {
    exec: (query, ...values) => {
      const statement = db.prepare(query)
      const rows = /^\s*(SELECT|WITH)|RETURNING/i.test(query) ? (statement.all(...values) as Record<string, string | number | null>[]) : (statement.run(...values), [])
      return {toArray: () => rows}
    },
    databaseSize: 4096
  }
}

describe('relay stats', () => {
  it('keeps daily totals, and counts what the relay holds without naming anyone', () => {
    let now = Date.parse('2026-10-15T12:00:00Z')
    const sql = memorySql()
    const stats = sqlStats(sql, () => now)
    stats.count('connections')
    stats.count('connections')
    stats.count('stored_bytes', 1200)
    stats.count('stored_bytes', 0)
    now += 86400_000
    stats.count('connections')
    sql.exec('CREATE TABLE push_targets (endpoint TEXT PRIMARY KEY)')
    sql.exec('CREATE TABLE push_topics (topic TEXT, endpoint TEXT)')
    sql.exec("INSERT INTO push_targets VALUES ('a'), ('b')")
    sql.exec("INSERT INTO push_topics VALUES ('t1', 'a'), ('t1', 'b'), ('t2', 'a')")
    const read = stats.read(3)
    expect(read.days).toEqual([
      {day: '2026-10-15', counter: 'connections', count: 2},
      {day: '2026-10-15', counter: 'stored_bytes', count: 1200},
      {day: '2026-10-16', counter: 'connections', count: 1}
    ])
    expect(read.now).toMatchObject({devicesWithNotifications: 2, chatsWithNotifications: 2, storedMessages: 0, connected: 3})
    // Old totals are dropped.
    now += 400 * 86400_000
    stats.trim()
    expect(stats.read(0, 1000).days).toEqual([{day: '2026-10-16', counter: 'connections', count: 1}])
  })

  it('counts incoming messages by kind in memory, and writes them in batches', () => {
    const sql = memorySql()
    let writes = 0
    const exec = sql.exec
    sql.exec = (query, ...values) => {
      if (/^\s*INSERT INTO daily/.test(query)) writes++
      return exec(query, ...values)
    }
    const stats = sqlStats(sql, () => Date.parse('2026-10-15T12:00:00Z'))
    for (let i = 0; i < 24; i++) stats.tally('in_announce')
    expect(writes).toBe(0)
    stats.tally('in_awake')
    // The 25th is a batch: one write per kind, not one per message.
    expect(writes).toBe(2)
    stats.tally('in_req')
    expect(stats.read(0).days.map(({counter, count}) => [counter, count])).toEqual([['in_announce', 24], ['in_awake', 1], ['in_req', 1]])
  })

  it('tells the kinds of message apart', () => {
    expect(incomingKind('EVENT', {kind: 20001})).toBe('in_announce')
    expect(incomingKind('EVENT', {kind: 7467})).toBe('in_store')
    expect(incomingKind('EVENT', {kind: 1})).toBe('in_event_other')
    expect(incomingKind('REQ', 's')).toBe('in_req')
    expect(incomingKind('AWAKE', [])).toBe('in_awake')
    expect(incomingKind('HELLO', null)).toBe('in_other')
    expect(incomingKind(7, null)).toBe('in_other')
  })

  it("rewrites someone's 'using the app' record only once less than half of it is left", () => {
    const sql = memorySql()
    const pushes = sqlPushes(sql, '{}', () => {}, sqlStats(sql))
    let writes = 0
    const exec = sql.exec
    sql.exec = (query, ...values) => {
      if (/push_awake/.test(query) && /INSERT|DELETE/.test(query)) writes++
      return exec(query, ...values)
    }
    const topics = [{topic: 'a'.repeat(64), me: 'b'.repeat(32)}]
    const realNow = Date.now
    let now = realNow()
    Date.now = () => now
    try {
      pushes.awake(topics, 180)
      expect(writes).toBe(1)
      now += 60_000
      pushes.awake(topics, 180)
      expect(writes).toBe(1)
      now += 60_000
      pushes.awake(topics, 180)
      expect(writes).toBe(2)
      pushes.awake(topics, 0)
      expect(writes).toBe(3)
    } finally {
      Date.now = realNow
    }
  })
})
