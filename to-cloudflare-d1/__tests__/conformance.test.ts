/**
 * Shared store-contract conformance (noy-db-to#26).
 *
 * Runs against a REAL SQLite engine: D1 *is* SQLite at the edge, so wrapping
 * `node:sqlite` (in-memory) in the `D1Database` duck shape exercises the
 * store's actual SQL (RETURNING, ON CONFLICT upserts, batch) on the same
 * engine family it targets in production — no mock interpretation layer.
 *
 * `batch()` runs its statements inside BEGIN…COMMIT, matching D1's
 * atomic-per-batch semantics that back the store's `txAtomic` capability.
 */
import { describe, expect, it } from 'vitest'
import { runStoreConformanceTests } from '@noy-db/ports/to'
import { toCloudflareD1 } from '../src/index.js'
import { d1OverNodeSqlite } from './_engine.js'

runStoreConformanceTests('to-cloudflare-d1 (node:sqlite via D1Database shape)', async () =>
  toCloudflareD1({ db: d1OverNodeSqlite() }),
)

// family#174 — an id holding a NUL (hub's partitioned sequence and period keys)
// must come back whole from list, loadAll and listPage, and the listPage cursor
// must step past it. node:sqlite cuts a TEXT read at the NUL, which is why ids
// are read as hex(id). Kept here because the pinned kit predates the case.
describe('to-cloudflare-d1 NUL-bearing ids (family#174)', () => {
  const env = (v: number) => ({ _noydb: 1 as const, _v: v, _ts: new Date(0).toISOString(), _iv: 'aaaa', _data: `d${v}` })
  const ids = ['a', 'a\0x', 'a\0y', 'b\0z/EU']

  it('round-trips through list, loadAll and a paged listPage', async () => {
    const store = toCloudflareD1({ db: d1OverNodeSqlite() })
    for (const [i, id] of ids.entries()) await store.put('v', 'c', id, env(i + 1))
    expect(await store.list('v', 'c')).toEqual(ids)
    expect(Object.keys((await store.loadAll('v')).c!)).toEqual(ids)
    const seen: string[] = []
    let cursor: string | undefined
    do {
      const page = await store.listPage!('v', 'c', cursor, 1)
      seen.push(...page.items.map(x => x.id))
      cursor = page.nextCursor ?? undefined
    } while (cursor !== undefined)
    expect(seen).toEqual(ids)
  })
})
