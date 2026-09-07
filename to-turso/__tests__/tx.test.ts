import { describe, expect, it } from 'vitest'
import { ConflictError } from '@noy-db/hub/to'
import type { EncryptedEnvelope } from '@noy-db/hub/to'
import { toTurso } from '../src/index.js'
import { libsqlOverNodeSqlite } from './_engine.js'

// noy-db-to#37 — the client.batch() path of tx() must enforce every
// op.expectedVersion atomically inside the batch: a mismatch throws
// ConflictError and NOTHING is applied. Runs on a real SQLite engine whose
// batch() is BEGIN…COMMIT/ROLLBACK, same as libSQL's implicit transaction.

function env(v: number, data = 'd'): EncryptedEnvelope {
  return { _noydb: 1, _v: v, _ts: new Date().toISOString(), _iv: 'i', _data: Buffer.from(data).toString('base64') }
}

describe('to-turso — batch tx() expectedVersion enforcement (#37)', () => {
  it('commits the batch when every expectedVersion matches', async () => {
    const store = toTurso({ client: libsqlOverNodeSqlite() })
    await store.put('v', 'c', 'a', env(1, 'a1'))
    await store.tx!([
      { type: 'put', vault: 'v', collection: 'c', id: 'a', envelope: env(2, 'a2'), expectedVersion: 1 },
      { type: 'put', vault: 'v', collection: 'c', id: 'b', envelope: env(1, 'b1'), expectedVersion: 0 },
    ])
    expect((await store.get('v', 'c', 'a'))?._v).toBe(2)
    expect((await store.get('v', 'c', 'b'))?._v).toBe(1)
  })

  it('throws ConflictError on version mismatch with zero writes applied', async () => {
    const store = toTurso({ client: libsqlOverNodeSqlite() })
    await store.put('v', 'c', 'a', env(3, 'a3'))
    await expect(store.tx!([
      { type: 'put', vault: 'v', collection: 'c', id: 'fresh', envelope: env(1, 'f') },
      { type: 'put', vault: 'v', collection: 'c', id: 'a', envelope: env(9, 'stale'), expectedVersion: 1 },
    ])).rejects.toThrow(ConflictError)
    expect(await store.get('v', 'c', 'fresh')).toBeNull()          // zero partial writes
    expect((await store.get('v', 'c', 'a'))?._v).toBe(3)           // target untouched
  })

  it('throws ConflictError when expectedVersion 0 hits an existing row (create-only)', async () => {
    const store = toTurso({ client: libsqlOverNodeSqlite() })
    await store.put('v', 'c', 'a', env(1))
    await expect(store.tx!([
      { type: 'put', vault: 'v', collection: 'c', id: 'a', envelope: env(1, 'dupe'), expectedVersion: 0 },
    ])).rejects.toThrow(ConflictError)
  })

  it('enforces expectedVersion on the delete leg too', async () => {
    const store = toTurso({ client: libsqlOverNodeSqlite() })
    await store.put('v', 'c', 'a', env(2))
    await store.put('v', 'c', 'keep', env(1, 'keep'))
    await expect(store.tx!([
      { type: 'delete', vault: 'v', collection: 'c', id: 'keep' },
      { type: 'delete', vault: 'v', collection: 'c', id: 'a', expectedVersion: 5 },
    ])).rejects.toThrow(ConflictError)
    expect(await store.get('v', 'c', 'keep')).not.toBeNull()       // delete rolled back
  })

  it('a put op missing its envelope fails without partial application', async () => {
    const store = toTurso({ client: libsqlOverNodeSqlite() })
    await expect(store.tx!([
      { type: 'put', vault: 'v', collection: 'c', id: 'good', envelope: env(1) },
      { type: 'put', vault: 'v', collection: 'c', id: 'bad' },
    ])).rejects.toThrow()
    expect(await store.get('v', 'c', 'good')).toBeNull()
  })
})
