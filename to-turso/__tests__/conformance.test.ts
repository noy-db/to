/**
 * Shared store-contract conformance (noy-db-to#26).
 *
 * Runs against a REAL SQLite engine: `node:sqlite` (in-memory) wrapped in the
 * `LibsqlClient` duck shape — libSQL is a SQLite fork, so the SQL surface the
 * store emits (RETURNING, ON CONFLICT upserts, unixepoch) executes natively.
 * A mock can only fail the ways its author anticipated; this cannot.
 *
 * `batch()` wraps its statements in BEGIN…COMMIT, mirroring libSQL's implicit
 * one-transaction batch semantics — which is exactly the atomicity claim the
 * store's `txAtomic` capability makes (#22).
 */
import { describe, expect, it } from 'vitest'
import { runStoreConformanceTests } from '@noy-db/ports/to'
import { toTurso } from '../src/index.js'
import { libsqlOverNodeSqlite } from './_engine.js'

runStoreConformanceTests('to-turso (node:sqlite via LibsqlClient shape)', async () =>
  toTurso({ client: libsqlOverNodeSqlite() }),
)

// family#170 — without `batch()` there is no atomic tx, so the store must offer
// neither `tx()` nor `txAtomic`. The kit checks both, and the tx cases with them.
runStoreConformanceTests('to-turso (no batch(): no tx)', async () => {
  const { batch: _batch, ...client } = libsqlOverNodeSqlite()
  return toTurso({ client })
})

// The no-`batch()` fallback has no transaction, so its saveAll writes first and
// prunes second (family#147). Same outcome as the batch path, asserted directly.
describe('to-turso saveAll without batch() (sequential fallback)', () => {
  const env = (v: number, data: string) => ({ _noydb: 1 as const, _v: v, _ts: new Date(0).toISOString(), _iv: 'aaaa', _data: data })

  it('replaces non-underscore collections and leaves _keyring standing', async () => {
    const { batch: _batch, ...client } = libsqlOverNodeSqlite()
    const store = toTurso({ client })
    await store.put('v', '_keyring', 'alice', env(1, 'key'))
    await store.saveAll('v', { keep: { k1: env(1, 'k'), k2: env(1, 'k2') }, drop: { d1: env(1, 'd') } })
    await store.saveAll('v', { keep: { k1: env(2, 'k-v2') }, empty: {} })

    expect(await store.get('v', 'drop', 'd1')).toBeNull()
    expect(await store.list('v', 'keep')).toEqual(['k1'])
    expect((await store.get('v', 'keep', 'k1'))?._v).toBe(2)
    expect((await store.get('v', '_keyring', 'alice'))?._data).toBe('key')
  })
})

// family#174 — an id holding a NUL (hub's partitioned sequence and period keys)
// must come back whole from list, loadAll and listPage, and the listPage cursor
// must step past it. node:sqlite cuts a TEXT read at the NUL, which is why ids
// are read as hex(id). Kept here because the pinned kit predates the case.
describe('to-turso NUL-bearing ids (family#174)', () => {
  const env = (v: number) => ({ _noydb: 1 as const, _v: v, _ts: new Date(0).toISOString(), _iv: 'aaaa', _data: `d${v}` })
  const ids = ['a', 'a\0x', 'a\0y', 'b\0z/EU']

  it('round-trips through list, loadAll and a paged listPage', async () => {
    const store = toTurso({ client: libsqlOverNodeSqlite() })
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
