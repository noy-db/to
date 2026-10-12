import { describe, expect, it } from 'vitest'
import type { EncryptedEnvelope } from '@noy-db/hub'
import { toAwsDynamo } from '../src/index.js'
import { fakeDynamo } from './_fake-dynamo.js'

// noy-db/family#148 — sk is `{collection}#{id}` split at the first '#', so a
// '#' in a collection name bleeds one collection into another.

function env(v: number): EncryptedEnvelope {
  return {
    _noydb: 1, _v: v, _ts: new Date(1700000000000 + v * 1000).toISOString(),
    _iv: 'aaaa', _data: `ciphertext-${v}`, _by: 'alice',
  }
}

describe('@noy-db/to-aws-dynamo collection names', () => {
  it('refuses "#" in a collection name on every path', async () => {
    const store = toAwsDynamo({ table: 't', client: fakeDynamo().client })
    await expect(store.put('v', 'a#b', 'r', env(1))).rejects.toThrow(/must not contain '#'/)
    await expect(store.get('v', 'a#b', 'r')).rejects.toThrow(/must not contain '#'/)
    await expect(store.list('v', 'a#b')).rejects.toThrow(/must not contain '#'/)
    await expect(store.listPage!('v', 'a#b')).rejects.toThrow(/must not contain '#'/)
  })

  it('still accepts "#" in a record id', async () => {
    const store = toAwsDynamo({ table: 't', client: fakeDynamo().client })
    await store.put('v', 'a', 'r#1', env(1))
    expect(await store.list('v', 'a')).toEqual(['r#1'])
    expect(await store.get('v', 'a', 'r#1')).toEqual(env(1))
  })
})
