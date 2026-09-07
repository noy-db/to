import { describe, expect, it, beforeEach } from 'vitest'
import type { EncryptedEnvelope } from '@noy-db/hub'
import { ConflictError } from '@noy-db/hub'
import { toMysql } from '../src/index.js'
import { mockClient } from './_mock.js'

function env(v: number): EncryptedEnvelope {
  return { _noydb: 1, _v: v, _ts: new Date(1700000000000 + v * 1000).toISOString(), _iv: 'aaaa', _data: `ct-${v}`, _by: 'alice' }
}

describe('@noy-db/to-mysql', () => {
  let client: ReturnType<typeof mockClient>
  let store: ReturnType<typeof toMysql>
  beforeEach(() => {
    client = mockClient()
    store = toMysql({ client })
  })

  it('name is "mysql"', () => expect(store.name).toBe('mysql'))

  it('put + get round-trip', async () => {
    await store.put('v1', 'c1', 'r1', env(1))
    expect(await store.get('v1', 'c1', 'r1')).toEqual(env(1))
  })

  it('get returns null when missing', async () => {
    expect(await store.get('v1', 'c1', 'nope')).toBeNull()
  })

  it('list returns sorted ids', async () => {
    await store.put('v1', 'c1', 'b', env(1))
    await store.put('v1', 'c1', 'a', env(1))
    expect(await store.list('v1', 'c1')).toEqual(['a', 'b'])
  })

  it('delete removes', async () => {
    await store.put('v1', 'c1', 'r1', env(1))
    await store.delete('v1', 'c1', 'r1')
    expect(await store.get('v1', 'c1', 'r1')).toBeNull()
  })

  it('expectedVersion match succeeds', async () => {
    await store.put('v1', 'c1', 'r1', env(1))
    await expect(store.put('v1', 'c1', 'r1', env(2), 1)).resolves.toBeUndefined()
  })

  it('expectedVersion mismatch throws ConflictError', async () => {
    await store.put('v1', 'c1', 'r1', env(1))
    await expect(store.put('v1', 'c1', 'r1', env(2), 999)).rejects.toBeInstanceOf(ConflictError)
  })

  it('loadAll groups by collection', async () => {
    await store.put('v1', 'c1', 'r1', env(1))
    await store.put('v1', 'c2', 'r2', env(1))
    const snap = await store.loadAll('v1')
    expect(Object.keys(snap).sort()).toEqual(['c1', 'c2'])
  })

  it('saveAll replaces vault contents', async () => {
    await store.put('v1', 'c1', 'old', env(1))
    await store.saveAll('v1', { c1: { new: env(9) } })
    expect(await store.get('v1', 'c1', 'old')).toBeNull()
    expect(await store.get('v1', 'c1', 'new')).toEqual(env(9))
  })

  it('listPage uses keyset paging', async () => {
    for (const id of ['r1', 'r2', 'r3', 'r4']) await store.put('v1', 'c1', id, env(1))
    const p1 = await store.listPage!('v1', 'c1', undefined, 2)
    expect(p1.items.map(x => x.id)).toEqual(['r1', 'r2'])
    expect(p1.nextCursor).toBe('r2')
    const p2 = await store.listPage!('v1', 'c1', p1.nextCursor!, 2)
    expect(p2.items.map(x => x.id)).toEqual(['r3', 'r4'])
    expect(p2.nextCursor).toBeNull()
  })

  it('tx batches ops', async () => {
    await store.tx!([
      { type: 'put', vault: 'v1', collection: 'c1', id: 'a', envelope: env(1) },
      { type: 'put', vault: 'v1', collection: 'c1', id: 'b', envelope: env(2) },
    ])
    expect(await store.list('v1', 'c1')).toEqual(['a', 'b'])
  })

  it('ping returns true', async () => {
    expect(await store.ping!()).toBe(true)
  })
})
