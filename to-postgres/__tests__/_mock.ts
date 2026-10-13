import type { EncryptedEnvelope } from '@noy-db/hub'
import type { PostgresClient } from '../src/index.js'

export interface Row { vault: string; collection: string; id: string; v: number; envelope: EncryptedEnvelope }

/**
 * In-memory mock of a pg-style Client. Parses the small set of SQL
 * patterns the store emits and answers from a Map. Extracted from
 * to-postgres.test.ts so the conformance suite (#26) can reuse it —
 * importing a *.test.ts file would re-run its describe blocks.
 */
export function mockClient(rows: Map<string, Row> = new Map()): PostgresClient & { rows: Map<string, Row> } {
  const key = (v: string, c: string, i: string) => `${v}\x00${c}\x00${i}`
  let inTx = false
  let txSnapshot: Map<string, Row> | null = null

  async function query<T>(sql: string, params?: readonly unknown[]): Promise<{ rows: T[] }> {
    const normalized = sql.replace(/\s+/g, ' ').trim().toUpperCase()
    const p = params ?? []
    // Real Postgres `text` refuses a 0x00 byte (family#174) — the mock must too.
    if (p.flat().some(x => typeof x === 'string' && x.includes('\0'))) {
      throw new Error('invalid byte sequence for encoding "UTF8": 0x00')
    }
    const ids = (x: unknown): string[] => (Array.isArray(x) ? x as string[] : [x as string])

    if (normalized.startsWith('CREATE TABLE')) return { rows: [] }
    if (normalized === 'BEGIN') {
      inTx = true
      txSnapshot = new Map(rows)
      return { rows: [] }
    }
    if (normalized === 'COMMIT') { inTx = false; txSnapshot = null; return { rows: [] } }
    if (normalized === 'ROLLBACK') {
      if (txSnapshot) {
        rows.clear()
        for (const [k, v] of txSnapshot) rows.set(k, v)
      }
      inTx = false; txSnapshot = null
      return { rows: [] }
    }
    if (normalized === 'SELECT 1') return { rows: [{ '?column?': 1 } as unknown as T] }

    if (normalized.startsWith('INSERT INTO')) {
      const [vault, collection, id, v, envelope] = p as [string, string, string, number, string]
      if (normalized.includes('DO NOTHING')) {
        if (rows.has(key(vault, collection, id))) return { rows: [] }
        rows.set(key(vault, collection, id), { vault, collection, id, v, envelope: JSON.parse(envelope) as EncryptedEnvelope })
        return { rows: [{ id } as unknown as T] }
      }
      rows.set(key(vault, collection, id), {
        vault, collection, id, v,
        envelope: JSON.parse(envelope) as EncryptedEnvelope,
      })
      return { rows: [] }
    }
    if (normalized.startsWith('UPDATE') && normalized.includes('SET ID = $4')) {
      // adoptLegacy: move a row onto its encoded key unless that key is taken.
      const [vault, collection, from, to] = p as [string, string, string, string]
      const row = rows.get(key(vault, collection, from))
      if (row && !rows.has(key(vault, collection, to))) {
        rows.delete(key(vault, collection, from))
        rows.set(key(vault, collection, to), { ...row, id: to })
      }
      return { rows: [] }
    }
    if (normalized.startsWith('UPDATE')) {
      const [vault, collection, id, v, envelope, expected] = p as [string, string, string, number, string, number]
      const row = rows.get(key(vault, collection, id))
      if (!row || row.v !== expected) return { rows: [] }
      rows.set(key(vault, collection, id), { vault, collection, id, v, envelope: JSON.parse(envelope) as EncryptedEnvelope })
      return { rows: [{ id } as unknown as T] }
    }
    if (normalized.startsWith('DELETE FROM')) {
      if (p.length === 4) {
        const [vault, collection, id, expected] = p as [string, string, string, number]
        const row = rows.get(key(vault, collection, id))
        if (!row || row.v !== expected) return { rows: [] }
        rows.delete(key(vault, collection, id))
        return { rows: [{ id } as unknown as T] }
      }
      if (p.length === 3) {
        const [vault, collection, id] = p as [string, string, unknown]
        for (const i of ids(id)) rows.delete(key(vault, collection, i))
      } else if (p.length === 1) {
        const [vault] = p as [string]
        const keepUnderscore = normalized.includes("<> '_'")
        for (const [k, r] of rows) if (r.vault === vault && !(keepUnderscore && r.collection.startsWith('_'))) rows.delete(k)
      }
      return { rows: [] }
    }
    if (normalized.startsWith('SELECT ID, ENVELOPE FROM') && normalized.includes('ANY(')) {
      const [vault, collection, keys] = p as [string, string, string[]]
      const found = keys.map(k => rows.get(key(vault, collection, k))).filter((r): r is Row => r !== undefined)
      return { rows: found.map(r => ({ id: r.id, envelope: r.envelope })) as unknown as T[] }
    }
    if (normalized.startsWith('SELECT V FROM')) {
      const [vault, collection, id] = p as [string, string, string]
      const row = rows.get(key(vault, collection, id))
      return { rows: row ? [{ v: row.v } as unknown as T] : [] }
    }
    if (normalized.startsWith('SELECT ID FROM')) {
      const [vault, collection] = p as [string, string]
      const ids = [...rows.values()]
        .filter(r => r.vault === vault && r.collection === collection)
        .sort((a, b) => a.id.localeCompare(b.id))
        .map(r => ({ id: r.id }))
      return { rows: ids as unknown as T[] }
    }
    if (normalized.includes('FROM') && normalized.includes('WHERE VAULT = $1 AND COLLECTION = $2 AND ID > $3')) {
      const [vault, collection, afterId, limit] = p as [string, string, string, number]
      const matched = [...rows.values()]
        .filter(r => r.vault === vault && r.collection === collection && r.id > afterId)
        .sort((a, b) => a.id.localeCompare(b.id))
        .slice(0, limit)
        .map(r => ({ id: r.id, envelope: r.envelope }))
      return { rows: matched as unknown as T[] }
    }
    if (normalized.startsWith('SELECT ID, COLLECTION, V, ENVELOPE FROM')) {
      const [vault] = p as [string]
      const matched = [...rows.values()]
        .filter(r => r.vault === vault)
        .map(r => ({ id: r.id, collection: r.collection, v: r.v, envelope: r.envelope }))
      return { rows: matched as unknown as T[] }
    }
    void inTx
    throw new Error(`mock pg: unsupported SQL: ${normalized}`)
  }

  return { query, rows }
}

/**
 * In-memory mock of a pg `Pool`. Every connection shares one row map but
 * holds its own transaction state, and `pool.query()` runs each statement
 * on a fresh connection — which is pg.Pool's real contract, and why a
 * BEGIN / DELETE / ROLLBACK sent through `pool.query()` is three
 * unrelated sessions (noy-db/family#144). `checkedOut` counts connections
 * taken with `connect()` and not yet released.
 */
export function mockPool(): PostgresClient & {
  rows: Map<string, Row>
  connect(): Promise<PostgresClient & { release(): void }>
  totalCount: number
  checkedOut: number
} {
  const rows = new Map<string, Row>()
  const pool = {
    rows,
    totalCount: 0,
    checkedOut: 0,
    query: <T>(sql: string, params?: readonly unknown[]) => mockClient(rows).query<T>(sql, params),
    async connect() {
      pool.checkedOut++
      const conn = mockClient(rows)
      let released = false
      return {
        query: conn.query,
        release() {
          if (!released) { released = true; pool.checkedOut-- }
        },
      }
    },
  }
  return pool
}
