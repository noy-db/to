import { describe, expect, it } from 'vitest'
import type { EncryptedEnvelope } from '@noy-db/hub'
import { toAwsS3 } from '../src/index.js'
import { fakeS3 } from './_fake-s3.js'

// noy-db/family#146 — list() and loadAll() must follow the continuation
// token past the first ListObjectsV2 page. The fake cuts pages at 2 items.

function env(v: number): EncryptedEnvelope {
  return {
    _noydb: 1, _v: v, _ts: new Date(1700000000000 + v * 1000).toISOString(),
    _iv: 'aaaa', _data: `ciphertext-${v}`, _by: 'alice',
  }
}

describe('@noy-db/to-aws-s3 pagination', () => {
  it('list() and loadAll() return every record across pages', async () => {
    const store = toAwsS3({ bucket: 'b', client: fakeS3({ pageSize: 2 }).client })
    const ids = ['r1', 'r2', 'r3', 'r4', 'r5']
    for (const id of ids) await store.put('v1', 'c1', id, env(1))
    await store.put('v1', 'c2', 'x', env(1))
    await store.put('v1', '_keyring', 'alice', env(1))

    expect((await store.list('v1', 'c1')).sort()).toEqual(ids)
    const snap = await store.loadAll('v1')
    expect(Object.keys(snap).sort()).toEqual(['c1', 'c2'])
    expect(Object.keys(snap.c1!).sort()).toEqual(ids)
  })
})
