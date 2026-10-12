import { describe, expect, it, beforeEach } from 'vitest'
import type { EncryptedEnvelope } from '@noy-db/hub'
import { ConflictError } from '@noy-db/hub'
import { toMysql } from '../src/index.js'
import { mockClient } from './_mock.js'

// noy-db/family#145 — CAS must be ONE conditional statement. A SELECT-then-
// upsert lets two writers holding the same expectedVersion both pass.

function env(v: number, tag = 'x'): EncryptedEnvelope {
  return {
    _noydb: 1, _v: v, _ts: new Date(1700000000000 + v * 1000).toISOString(),
    _iv: 'aaaa', _data: `ciphertext-${v}-${tag}`, _by: 'alice',
  }
}

describe('@noy-db/to-mysql CAS', () => {
  let store: ReturnType<typeof toMysql>
  beforeEach(() => {
    store = toMysql({ client: mockClient() })
  })

  it('two racing writers at the same expectedVersion: exactly one wins', async () => {
    await store.put('v1', 'c1', 'r', env(1))
    const results = await Promise.allSettled([
      store.put('v1', 'c1', 'r', env(2, 'a'), 1),
      store.put('v1', 'c1', 'r', env(2, 'b'), 1),
    ])
    expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1)
    const lost = results.find(r => r.status === 'rejected') as PromiseRejectedResult
    expect(lost.reason).toBeInstanceOf(ConflictError)
  })

  it('two racing creates (expectedVersion 0): exactly one wins', async () => {
    const results = await Promise.allSettled([
      store.put('v1', 'c1', 'new', env(1, 'a'), 0),
      store.put('v1', 'c1', 'new', env(1, 'b'), 0),
    ])
    expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1)
  })

  it('expectedVersion N against an absent row throws ConflictError(0)', async () => {
    const err = await store.put('v1', 'c1', 'gone', env(3), 2).catch(e => e)
    expect(err).toBeInstanceOf(ConflictError)
    expect((err as ConflictError).version).toBe(0)
    expect(await store.get('v1', 'c1', 'gone')).toBeNull()
  })

  it('tx delete with a stale expectedVersion conflicts and deletes nothing', async () => {
    await store.put('v1', 'c1', 'r', env(2))
    await expect(store.tx!([
      { type: 'delete', vault: 'v1', collection: 'c1', id: 'r', expectedVersion: 1 },
    ])).rejects.toThrow(ConflictError)
    expect(await store.get('v1', 'c1', 'r')).toEqual(env(2))
  })
})
