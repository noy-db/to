import { describe, expect, it } from 'vitest'
import { ConflictError } from '@noy-db/hub/to'
import type { EncryptedEnvelope } from '@noy-db/hub/to'
import { toAwsDynamo } from '../src/index.js'
import { fakeDynamo } from './_fake-dynamo.js'

// noy-db-to#41 — tx() via TransactWriteItems: every op commits atomically,
// every expectedVersion enforced via per-item ConditionExpression; a
// mismatch maps TransactionCanceledException/ConditionalCheckFailed →
// ConflictError with NOTHING applied. Mock-tested (family CI rule: no real
// AWS) against the fake's transact modeling.

function env(v: number, data = 'd'): EncryptedEnvelope {
  return { _noydb: 1, _v: v, _ts: new Date().toISOString(), _iv: 'i', _data: Buffer.from(data).toString('base64') }
}

describe('to-aws-dynamo — tx() via TransactWriteItems (#41)', () => {
  it('declares capabilities.txAtomic', () => {
    const store = toAwsDynamo({ table: 't', client: fakeDynamo().client })
    expect(store.capabilities.txAtomic).toBe(true)
  })

  it('commits the batch when every expectedVersion matches', async () => {
    const store = toAwsDynamo({ table: 't', client: fakeDynamo().client })
    await store.put('v', 'c', 'a', env(1, 'a1'))
    await store.tx!([
      { type: 'put', vault: 'v', collection: 'c', id: 'a', envelope: env(2, 'a2'), expectedVersion: 1 },
      { type: 'put', vault: 'v', collection: 'c', id: 'b', envelope: env(1, 'b1'), expectedVersion: 0 },
    ])
    expect((await store.get('v', 'c', 'a'))?._v).toBe(2)
    expect((await store.get('v', 'c', 'b'))?._v).toBe(1)
  })

  it('throws ConflictError on version mismatch with zero writes applied', async () => {
    const store = toAwsDynamo({ table: 't', client: fakeDynamo().client })
    await store.put('v', 'c', 'a', env(3, 'a3'))
    await expect(store.tx!([
      { type: 'put', vault: 'v', collection: 'c', id: 'fresh', envelope: env(1, 'f') },
      { type: 'put', vault: 'v', collection: 'c', id: 'a', envelope: env(9, 'stale'), expectedVersion: 1 },
    ])).rejects.toThrow(ConflictError)
    expect(await store.get('v', 'c', 'fresh')).toBeNull()          // zero partial writes
    expect((await store.get('v', 'c', 'a'))?._v).toBe(3)           // target untouched
  })

  it('throws ConflictError when expectedVersion 0 hits an existing item (create-only)', async () => {
    const store = toAwsDynamo({ table: 't', client: fakeDynamo().client })
    await store.put('v', 'c', 'a', env(1))
    await expect(store.tx!([
      { type: 'put', vault: 'v', collection: 'c', id: 'a', envelope: env(1, 'dupe'), expectedVersion: 0 },
    ])).rejects.toThrow(ConflictError)
  })

  it('enforces expectedVersion on the delete leg too', async () => {
    const store = toAwsDynamo({ table: 't', client: fakeDynamo().client })
    await store.put('v', 'c', 'a', env(2))
    await store.put('v', 'c', 'keep', env(1, 'keep'))
    await expect(store.tx!([
      { type: 'delete', vault: 'v', collection: 'c', id: 'keep' },
      { type: 'delete', vault: 'v', collection: 'c', id: 'a', expectedVersion: 5 },
    ])).rejects.toThrow(ConflictError)
    expect(await store.get('v', 'c', 'keep')).not.toBeNull()       // delete not applied
  })

  it('a put op missing its envelope fails without partial application', async () => {
    const store = toAwsDynamo({ table: 't', client: fakeDynamo().client })
    await expect(store.tx!([
      { type: 'put', vault: 'v', collection: 'c', id: 'good', envelope: env(1) },
      { type: 'put', vault: 'v', collection: 'c', id: 'bad' },
    ])).rejects.toThrow()
    expect(await store.get('v', 'c', 'good')).toBeNull()
  })

  it('throws a clear error for batches over 100 ops — never silently splits', async () => {
    const store = toAwsDynamo({ table: 't', client: fakeDynamo().client })
    const ops = Array.from({ length: 101 }, (_, i) => ({
      type: 'put' as const, vault: 'v', collection: 'c', id: `id${i}`, envelope: env(1),
    }))
    await expect(store.tx!(ops)).rejects.toThrow(/100/)
    expect(await store.list('v', 'c')).toEqual([])                 // nothing applied
  })
})
