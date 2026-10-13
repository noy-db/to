/**
 * Shared store-contract conformance (noy-db-to#19).
 *
 * Runs against a REAL SQLite engine (`node:sqlite`, in-memory), not a mock, so
 * this is the strongest conformance signal in the repo — a mock can only fail
 * the ways its author anticipated.
 *
 * A fresh `:memory:` database per case: `DatabaseSync(':memory:')` is scoped to
 * its handle, so a new handle IS the isolation, and there is nothing to tear
 * down between cases.
 */
import { DatabaseSync } from 'node:sqlite'
import { describe, expect, it } from 'vitest'
import { runStoreConformanceTests } from '@noy-db/ports/to'
import { toSqlite } from '../src/index.js'

runStoreConformanceTests('to-sqlite (node:sqlite, in-memory)', async () =>
  toSqlite({ db: new DatabaseSync(':memory:') }),
)

// family#174 — an id holding a NUL (hub's partitioned sequence and period keys)
// must come back whole from list, loadAll and listPage, and the listPage cursor
// must step past it. node:sqlite cuts a TEXT read at the NUL, which is why ids
// are read as hex(id). Kept here because the pinned kit predates the case.
describe('to-sqlite NUL-bearing ids (family#174)', () => {
  const env = (v: number) => ({ _noydb: 1 as const, _v: v, _ts: new Date(0).toISOString(), _iv: 'aaaa', _data: `d${v}` })
  const ids = ['a', 'a\0x', 'a\0y', 'b\0z/EU']

  it('round-trips through list, loadAll and a paged listPage', async () => {
    const store = toSqlite({ db: new DatabaseSync(':memory:') })
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
