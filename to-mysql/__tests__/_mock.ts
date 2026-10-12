import type { EncryptedEnvelope } from '@noy-db/hub'
import type { MysqlClient } from '../src/index.js'

export interface Row { vault: string; collection: string; id: string; v: number; envelope: EncryptedEnvelope }

/**
 * In-memory mock of a mysql2-style client. Parses the small set of SQL
 * patterns the store emits and answers from a Map. Extracted from
 * to-mysql.test.ts so the conformance suite (#26) can reuse it.
 */
export function mockClient(rowMap: Map<string, Row> = new Map()): MysqlClient & { rowMap: Map<string, Row> } {
  const key = (v: string, c: string, i: string) => `${v}\x00${c}\x00${i}`
  // Transaction fidelity (mirrors the to-postgres mock): START TRANSACTION
  // snapshots the map so ROLLBACK actually restores pre-transaction state —
  // the store's tx() rollback guarantees are only testable against a mock
  // that models them.
  let txSnapshot: Map<string, Row> | null = null

  async function execute<T>(sql: string, params?: readonly unknown[]): Promise<[T[], unknown]> {
    const normalized = sql.replace(/\s+/g, ' ').trim().toUpperCase()
    const p = params ?? []

    if (normalized.startsWith('CREATE TABLE')) return [[], null]
    if (normalized === 'START TRANSACTION') {
      txSnapshot = new Map(rowMap)
      return [[], null]
    }
    if (normalized === 'COMMIT') {
      txSnapshot = null
      return [[], null]
    }
    if (normalized === 'ROLLBACK') {
      if (txSnapshot) {
        rowMap.clear()
        for (const [k, r] of txSnapshot) rowMap.set(k, r)
        txSnapshot = null
      }
      return [[], null]
    }
    if (normalized === 'SELECT 1') return [[{ '1': 1 } as unknown as T], null]

    if (normalized.startsWith('INSERT INTO')) {
      const [vault, collection, id, v, envelope] = p as [string, string, string, number, string]
      if (!normalized.includes('ON DUPLICATE KEY') && rowMap.has(key(vault, collection, id))) {
        throw Object.assign(new Error('Duplicate entry'), { code: 'ER_DUP_ENTRY', errno: 1062 })
      }
      rowMap.set(key(vault, collection, id), {
        vault, collection, id, v,
        envelope: JSON.parse(envelope) as EncryptedEnvelope,
      })
      return [[], null]
    }
    if (normalized.startsWith('UPDATE')) {
      const [v, envelope, vault, collection, id, expected] = p as [number, string, string, string, string, number]
      const row = rowMap.get(key(vault, collection, id))
      if (!row || row.v !== expected) return [{ affectedRows: 0 } as unknown as T[], null]
      rowMap.set(key(vault, collection, id), { vault, collection, id, v, envelope: JSON.parse(envelope) as EncryptedEnvelope })
      return [{ affectedRows: 1 } as unknown as T[], null]
    }
    if (normalized.startsWith('DELETE FROM')) {
      if (p.length === 4) {
        const [vault, collection, id, expected] = p as [string, string, string, number]
        const row = rowMap.get(key(vault, collection, id))
        if (!row || row.v !== expected) return [{ affectedRows: 0 } as unknown as T[], null]
        rowMap.delete(key(vault, collection, id))
        return [{ affectedRows: 1 } as unknown as T[], null]
      }
      if (p.length === 3) {
        const [vault, collection, id] = p as [string, string, string]
        rowMap.delete(key(vault, collection, id))
      } else if (p.length === 1) {
        const [vault] = p as [string]
        for (const [k, r] of rowMap) if (r.vault === vault) rowMap.delete(k)
      }
      return [[], null]
    }
    if (normalized.startsWith('SELECT ENVELOPE FROM')) {
      const [vault, collection, id] = p as [string, string, string]
      const row = rowMap.get(key(vault, collection, id))
      return [row ? [{ envelope: row.envelope } as unknown as T] : [], null]
    }
    if (normalized.startsWith('SELECT V FROM')) {
      const [vault, collection, id] = p as [string, string, string]
      const row = rowMap.get(key(vault, collection, id))
      return [row ? [{ v: row.v } as unknown as T] : [], null]
    }
    if (normalized.startsWith('SELECT ID FROM')) {
      const [vault, collection] = p as [string, string]
      const ids = [...rowMap.values()]
        .filter(r => r.vault === vault && r.collection === collection)
        .sort((a, b) => a.id.localeCompare(b.id))
        .map(r => ({ id: r.id }))
      return [ids as unknown as T[], null]
    }
    if (normalized.includes('FROM') && normalized.includes('WHERE VAULT = ? AND COLLECTION = ? AND ID > ?')) {
      const [vault, collection, afterId, limit] = p as [string, string, string, number]
      const matched = [...rowMap.values()]
        .filter(r => r.vault === vault && r.collection === collection && r.id > afterId)
        .sort((a, b) => a.id.localeCompare(b.id))
        .slice(0, limit)
        .map(r => ({ id: r.id, envelope: r.envelope }))
      return [matched as unknown as T[], null]
    }
    if (normalized.startsWith('SELECT ID, COLLECTION, V, ENVELOPE FROM')) {
      const [vault] = p as [string]
      const matched = [...rowMap.values()]
        .filter(r => r.vault === vault)
        .map(r => ({ id: r.id, collection: r.collection, v: r.v, envelope: r.envelope }))
      return [matched as unknown as T[], null]
    }
    throw new Error(`mock mysql: unsupported SQL: ${normalized}`)
  }

  return { execute, rowMap }
}

/**
 * In-memory mock of a mysql2 `PromisePool`. Every connection shares one
 * row map but holds its own transaction state, and `pool.execute()` runs
 * each statement on a fresh connection — mysql2's real pool contract, and
 * why START TRANSACTION / DELETE / ROLLBACK sent through the pool are
 * unrelated sessions (noy-db/family#144). `checkedOut` counts connections
 * taken with `getConnection()` and not yet released.
 */
export function mockPool(): MysqlClient & {
  rowMap: Map<string, Row>
  getConnection(): Promise<MysqlClient & { release(): void }>
  checkedOut: number
} {
  const rowMap = new Map<string, Row>()
  const run = <T>(sql: string, params?: readonly unknown[]) => mockClient(rowMap).execute<T>(sql, params)
  const pool = {
    rowMap,
    checkedOut: 0,
    execute: run,
    query: <T>(sql: string) => run<T>(sql),
    async getConnection() {
      pool.checkedOut++
      const conn = mockClient(rowMap)
      let released = false
      return {
        execute: conn.execute,
        query: <T>(sql: string) => conn.execute<T>(sql),
        release() {
          if (!released) { released = true; pool.checkedOut-- }
        },
      }
    },
  }
  return pool
}
