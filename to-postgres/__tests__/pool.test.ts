import { describe, expect, it, beforeEach } from 'vitest'
import type { EncryptedEnvelope } from '@noy-db/hub'
import { toPostgres } from '../src/index.js'
import { mockPool } from './_mock.js'

// noy-db/family#144 — over a pool, BEGIN / DELETE / COMMIT must share ONE
// connection, or the vault-wide DELETE autocommits on its own and ROLLBACK
// lands on a connection with no transaction open.

function env(v: number): EncryptedEnvelope {
  return {
    _noydb: 1, _v: v, _ts: new Date(1700000000000 + v * 1000).toISOString(),
    _iv: 'aaaa', _data: `ciphertext-${v}`, _by: 'alice',
  }
}

/** JSON.stringify throws on a BigInt, so upsert fails AFTER the DELETE ran. */
const poison = { ...env(9), _data: 1n } as unknown as EncryptedEnvelope

describe('@noy-db/to-postgres over a pool', () => {
  let pool: ReturnType<typeof mockPool>
  let store: ReturnType<typeof toPostgres>
  beforeEach(() => {
    pool = mockPool()
    store = toPostgres({ client: pool })
  })

  it('saveAll that fails mid-way leaves the vault as it was', async () => {
    await store.put('v1', 'c1', 'keep', env(1))
    await expect(store.saveAll('v1', { c1: { a: env(2), b: poison } })).rejects.toThrow()
    expect(await store.get('v1', 'c1', 'keep')).toEqual(env(1))
    expect(await store.get('v1', 'c1', 'a')).toBeNull()
    expect(pool.checkedOut).toBe(0)
  })

  it('tx that fails mid-way rolls back its earlier ops', async () => {
    await expect(store.tx!([
      { type: 'put', vault: 'v1', collection: 'c1', id: 'a', envelope: env(1) },
      { type: 'put', vault: 'v1', collection: 'c1', id: 'b', envelope: poison },
    ])).rejects.toThrow()
    expect(await store.get('v1', 'c1', 'a')).toBeNull()
    expect(pool.checkedOut).toBe(0)
  })

  it('a successful saveAll and tx commit and release the connection', async () => {
    await store.put('v1', 'c1', 'old', env(1))
    await store.saveAll('v1', { c1: { new: env(2) } })
    await store.tx!([{ type: 'put', vault: 'v1', collection: 'c1', id: 'more', envelope: env(3) }])
    expect(await store.list('v1', 'c1')).toEqual(['more', 'new'])
    expect(pool.checkedOut).toBe(0)
  })
})
