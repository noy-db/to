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
