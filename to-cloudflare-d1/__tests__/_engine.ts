import { DatabaseSync } from 'node:sqlite'
import type { D1Database, D1PreparedStatement, D1Result } from '../src/index.js'

export function d1OverNodeSqlite(): D1Database {
  const db = new DatabaseSync(':memory:')

  function rowsFor(sql: string, args: readonly unknown[]): Record<string, unknown>[] {
    const stmt = db.prepare(sql)
    if (/^\s*(select|with)\b/i.test(sql) || /\breturning\b/i.test(sql)) {
      return stmt.all(...(args as never[])) as Record<string, unknown>[]
    }
    stmt.run(...(args as never[]))
    return []
  }

  function statement(sql: string, args: readonly unknown[]): D1PreparedStatement & { __sql: string; __args: readonly unknown[] } {
    return {
      __sql: sql,
      __args: args,
      bind: (...bound: readonly unknown[]) => statement(sql, bound),
      async first<T>() {
        return (rowsFor(sql, args)[0] ?? null) as T | null
      },
      async all<T>() {
        return { results: rowsFor(sql, args) as T[], success: true }
      },
      async run<T>() {
        rowsFor(sql, args)
        return { success: true } as D1Result<T>
      },
    }
  }

  return {
    prepare: (sql: string) => statement(sql, []),
    async batch<T>(statements: readonly D1PreparedStatement[]): Promise<D1Result<T>[]> {
      db.exec('BEGIN')
      try {
        const out = statements.map(s => {
          const { __sql, __args } = s as D1PreparedStatement & { __sql: string; __args: readonly unknown[] }
          return { results: rowsFor(__sql, __args) as T[], success: true }
        })
        db.exec('COMMIT')
        return out
      } catch (err) {
        db.exec('ROLLBACK')
        throw err
      }
    },
  }
}
