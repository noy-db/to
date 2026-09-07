import { DatabaseSync } from 'node:sqlite'
import type { LibsqlClient, LibsqlResultSet } from '../src/index.js'

export function libsqlOverNodeSqlite(): LibsqlClient {
  const db = new DatabaseSync(':memory:')

  function runOne(sql: string, args: readonly unknown[] = []): LibsqlResultSet {
    const stmt = db.prepare(sql)
    if (/^\s*(select|with)\b/i.test(sql) || /\breturning\b/i.test(sql)) {
      return { rows: stmt.all(...(args as never[])) as Record<string, unknown>[] }
    }
    stmt.run(...(args as never[]))
    return { rows: [] }
  }

  return {
    async execute(args) {
      return typeof args === 'string' ? runOne(args) : runOne(args.sql, args.args)
    },
    async batch(statements) {
      db.exec('BEGIN')
      try {
        const out = statements.map(s => runOne(s.sql, s.args))
        db.exec('COMMIT')
        return out
      } catch (err) {
        db.exec('ROLLBACK')
        throw err
      }
    },
  }
}
