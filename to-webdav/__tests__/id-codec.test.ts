import { describe, expect, it } from 'vitest'
import type { EncryptedEnvelope } from '@noy-db/hub'
import { toWebdav } from '../src/index.js'
import { fakeDav } from './_fake-dav.js'

// noy-db/family#174 — a NUL in an id is ENCODED, not refused, with to-file's
// codec (`%` and NUL only, per `/` component). The codec sits INSIDE the URL
// encoding: the fake's `files` keys are URL-decoded paths, so they show the
// codec's output as the server stores it.

function env(v: number): EncryptedEnvelope {
  return {
    _noydb: 1, _v: v, _ts: new Date(1700000000000 + v * 1000).toISOString(),
    _iv: 'aaaa', _data: `ciphertext-${v}`, _by: 'alice',
  }
}

function setup() {
  const dav = fakeDav()
  return { dav, store: toWebdav({ baseUrl: 'https://dav.example.com', fetch: dav.fetch }) }
}

describe('@noy-db/to-webdav id codec (family#174)', () => {
  it('keeps `a\\0b`, `a%00b` and `a%2500b` three records, nested ids included', async () => {
    const { dav, store } = setup()
    const ids = ['a\0b', 'a%00b', 'a%2500b', 'p\0q/r%s']
    for (const [i, id] of ids.entries()) await store.put('v', 'c', id, env(i + 1))
    for (const [i, id] of ids.entries()) expect(await store.get('v', 'c', id)).toEqual(env(i + 1))
    expect(await store.list('v', 'c')).toEqual([...ids].sort())
    expect(Object.keys((await store.loadAll('v')).c!).sort()).toEqual([...ids].sort())
    expect([...dav.files.keys()].sort()).toEqual(
      ['a%00b', 'a%2500b', 'a%252500b', 'p%00q/r%25s'].map(n => `v/c/${n}.json`).sort(),
    )
    // `a%00b` on disk is where `a\0b` lives: dropping `a%00b` must not take it along.
    await store.delete('v', 'c', 'a%00b')
    expect(await store.get('v', 'c', 'a%00b')).toBeNull()
    expect(await store.get('v', 'c', 'a\0b')).toEqual(env(1))
  })

  it('still reads, lists, deletes and prunes a pre-encoding record whose id holds a `%`', async () => {
    const { dav, store } = setup()
    await store.put('v', 'c', 'seed', env(9))
    await store.delete('v', 'c', 'seed')
    dav.files.set('v/c/x%3Ay.json', JSON.stringify(env(1)))
    dav.files.set('v/c/z%3Aw.json', JSON.stringify(env(2)))
    expect(await store.get('v', 'c', 'x%3Ay')).toEqual(env(1))
    expect(await store.list('v', 'c')).toEqual(['x%3Ay', 'z%3Aw'])
    expect((await store.loadAll('v')).c).toEqual({ 'x%3Ay': env(1), 'z%3Aw': env(2) })
    await store.delete('v', 'c', 'x%3Ay')
    expect(await store.get('v', 'c', 'x%3Ay')).toBeNull()
    // A CAS write sees the legacy version, and the id then lists once.
    await store.put('v', 'c', 'z%3Aw', env(3), 2)
    expect(await store.get('v', 'c', 'z%3Aw')).toEqual(env(3))
    expect(await store.list('v', 'c')).toEqual(['z%3Aw'])
    await store.saveAll('v', { c: {} })
    expect([...dav.files.keys()]).toEqual([])
  })
})
