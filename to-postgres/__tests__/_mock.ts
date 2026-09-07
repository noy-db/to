import type { EncryptedEnvelope } from '@noy-db/hub'
import type { PostgresClient } from '../src/index.js'

export interface Row { vault: string; collection: string; id: string; v: number; envelope: EncryptedEnvelope }

/**
 * In-memory mock of a pg-style Client. Parses the small set of SQL
 * patterns the store emits and answers from a Map. Extracted from
 * to-postgres.test.ts so the conformance suite (#26) can reuse it —
 * importing a *.test.ts file would re-run its describe blocks.
 */
export function mockClient(): PostgresClient & { rows: Map<string, Row> } {
  const rows = new Map<string, Row>()
  const key = (v: string, c: string, i: string) => `${v}\x00${c}\x00${i}`
  let inTx = false
  let txSnapshot: Map<string, Row> | null = null

  async function query<T>(sql: string, params?: readonly unknown[]): Promise<{ rows: T[] }> {
    const normalized = sql.replace(/\s+/g, ' ').trim().toUpperCase()
    const p = params ?? []

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
      rows.set(key(vault, collection, id), {
        vault, collection, id, v,
        envelope: JSON.parse(envelope) as EncryptedEnvelope,
      })
      return { rows: [] }
    }
    if (normalized.startsWith('DELETE FROM')) {
      if (p.length === 3) {
        const [vault, collection, id] = p as [string, string, string]
        rows.delete(key(vault, collection, id))
      } else if (p.length === 1) {
        const [vault] = p as [string]
        for (const [k, r] of rows) if (r.vault === vault) rows.delete(k)
      }
      return { rows: [] }
    }
    if (normalized.startsWith('SELECT ENVELOPE FROM')) {
      const [vault, collection, id] = p as [string, string, string]
      const row = rows.get(key(vault, collection, id))
      return { rows: row ? [{ envelope: row.envelope } as unknown as T] : [] }
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
