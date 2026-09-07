import { describe, expect, it } from 'vitest'
import type { PostgresClient } from '../src/index.js'
import { toSupabase } from '../src/index.js'

// Regression pin for noy-db-to#21, which claimed `txAtomic: true` is a false
// declaration because this package "contains no tx() implementation". The
// claim is wrong at the object level: `toSupabase()` spreads the ENTIRE
// `toPostgres()` store, so the returned object carries postgres's atomic
// `tx()` (BEGIN … COMMIT over the same injected pool) and the consumer guard
// `capabilities.txAtomic === true && typeof adapter.tx === 'function'` passes
// with genuine storage-layer atomicity. These tests pin that inheritance so a
// future refactor (e.g. hand-picking methods instead of spreading) cannot
// silently turn the declaration false.

function recordingClient(): PostgresClient & { queries: string[] } {
  const queries: string[] = []
  return {
    queries,
    async query<T>(sql: string): Promise<{ rows: T[] }> {
      queries.push(sql.replace(/\s+/g, ' ').trim().toUpperCase())
      return { rows: [] }
    },
  } as PostgresClient & { queries: string[] }
}

describe('to-supabase — tx() inheritance (regression pin for #21)', () => {
  it('the returned store carries an inherited callable tx() alongside txAtomic: true', () => {
    const store = toSupabase({ client: recordingClient() })
    expect(store.capabilities.txAtomic).toBe(true)
    expect(typeof store.tx).toBe('function')
  })

  it('tx() runs the ops inside BEGIN … COMMIT on the injected pool', async () => {
    const client = recordingClient()
    const store = toSupabase({ client })

    await store.tx!([{ type: 'delete', vault: 'v', collection: 'c', id: 'x' }])

    const begin = client.queries.indexOf('BEGIN')
    const commit = client.queries.indexOf('COMMIT')
    expect(begin).toBeGreaterThanOrEqual(0)
    expect(commit).toBeGreaterThan(begin)
    expect(client.queries.some(q => q.startsWith('DELETE FROM'))).toBe(true)
  })
})
