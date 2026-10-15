import {DatabaseSync} from 'node:sqlite'
import {describe, expect, it} from 'vitest'
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
})
