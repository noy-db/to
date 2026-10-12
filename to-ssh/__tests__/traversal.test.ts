import { posix } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { EncryptedEnvelope } from '@noy-db/hub'
import { toSsh } from '../src/index.js'
import { mockSftp } from './_mock.js'

// noy-db/family#148 — the segment rule ruled on family#133: vault and
// collection are single names; an id may carry '/', but no component of it
// may be empty, '.' or '..'; no backslash anywhere, and no NUL in a vault or
// collection. A NUL in an id is ENCODED, not refused (family#174).

function env(v: number): EncryptedEnvelope {
  return {
    _noydb: 1, _v: v, _ts: new Date(1700000000000 + v * 1000).toISOString(),
    _iv: 'aaaa', _data: `ciphertext-${v}`, _by: 'alice',
  }
}

const badNames = ['', '.', '..', 'a/b', 'a\\b', 'a\0b']
const badIds = ['', '.', '..', '../x', 'a/../b', '/x', 'x/', 'a//b', 'a\\b']

describe('@noy-db/to-ssh path segments', () => {
  it.each(badNames)('refuses vault %j', async (vault) => {
    const store = toSsh({ sftp: mockSftp() })
    await expect(store.put(vault, 'c', 'r', env(1))).rejects.toThrow(/vault must be a single path segment/)
  })

  it.each(badNames)('refuses collection %j', async (collection) => {
    const store = toSsh({ sftp: mockSftp() })
    await expect(store.put('v', collection, 'r', env(1))).rejects.toThrow(/collection must be a single path segment/)
  })

  it.each(badIds)('refuses id %j on put, get and delete', async (id) => {
    const store = toSsh({ sftp: mockSftp() })
    await expect(store.put('v', 'c', id, env(1))).rejects.toThrow(/record id/)
    await expect(store.get('v', 'c', id)).rejects.toThrow(/record id/)
    await expect(store.delete('v', 'c', id)).rejects.toThrow(/record id/)
  })

  it('accepts a slash-bearing id (hub index side-cars) and ordinary punctuation', async () => {
    const store = toSsh({ sftp: mockSftp() })
    for (const id of ['_idx/email/r1', 'with space.and.dots']) {
      await store.put('v', 'c', id, env(1))
      expect(await store.get('v', 'c', id)).toEqual(env(1))
    }
  })

  it('saveAll does not follow a listing that names ".."', async () => {
    const handle = mockSftp()
    // A server whose listing includes the dot entries and resolves '..'.
    const readdir = handle.readdir.bind(handle)
    const unlink = handle.unlink.bind(handle)
    handle.readdir = async (path: string) => ['.', '..', ...(await readdir(posix.normalize(path)))]
    handle.unlink = async (path: string) => unlink(posix.normalize(path))
    const store = toSsh({ sftp: handle })
    await store.put('v1', 'c1', 'r', env(1))
    await handle.writeFile('/noydb/stray.json', '{}')
    await store.saveAll('v1', {})
    expect(handle.files.has('/noydb/stray.json')).toBe(true)
  })

  it('encodes `%` and NUL per component, so `a\\0b`, `a%00b` and `a%2500b` stay three records (family#174)', async () => {
    const handle = mockSftp()
    const store = toSsh({ sftp: handle })
    const ids = ['a\0b', 'a%00b', 'a%2500b', 'p\0q/r%s']
    for (const [i, id] of ids.entries()) await store.put('v', 'c', id, env(i + 1))
    for (const [i, id] of ids.entries()) expect(await store.get('v', 'c', id)).toEqual(env(i + 1))
    expect(await store.list('v', 'c')).toEqual([...ids].sort())
    expect(Object.keys((await store.loadAll('v')).c!).sort()).toEqual([...ids].sort())
    expect([...handle.files.keys()].sort()).toEqual(
      ['a%00b', 'a%2500b', 'a%252500b', 'p%00q/r%25s'].map(n => `/noydb/v/c/${n}.json`).sort(),
    )
    // `a%00b` on disk is where `a\0b` lives: dropping `a%00b` must not take it along.
    await store.delete('v', 'c', 'a%00b')
    expect(await store.get('v', 'c', 'a%00b')).toBeNull()
    expect(await store.get('v', 'c', 'a\0b')).toEqual(env(1))
  })

  it('still reads, lists, deletes and prunes a pre-encoding record whose id holds a `%` (family#174)', async () => {
    const handle = mockSftp()
    const store = toSsh({ sftp: handle })
    await handle.writeFile('/noydb/v/c/x%3Ay.json', JSON.stringify(env(1)))
    await handle.writeFile('/noydb/v/c/z%3Aw.json', JSON.stringify(env(2)))
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
    expect([...handle.files.keys()]).toEqual([])
  })
})
