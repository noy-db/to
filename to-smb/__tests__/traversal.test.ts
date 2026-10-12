import { posix } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { EncryptedEnvelope } from '@noy-db/hub'
import { toSmb } from '../src/index.js'
import { mockSmb } from './_mock.js'

// noy-db/family#148 — the segment rule ruled on family#133: vault and
// collection are single names; an id may carry '/', but no component of it
// may be empty, '.' or '..'; no backslash or NUL anywhere.

function env(v: number): EncryptedEnvelope {
  return {
    _noydb: 1, _v: v, _ts: new Date(1700000000000 + v * 1000).toISOString(),
    _iv: 'aaaa', _data: `ciphertext-${v}`, _by: 'alice',
  }
}

const badNames = ['', '.', '..', 'a/b', 'a\\b', 'a\0b']
const badIds = ['', '.', '..', '../x', 'a/../b', '/x', 'x/', 'a//b', 'a\\b', 'a\0b']

describe('@noy-db/to-smb path segments', () => {
  it.each(badNames)('refuses vault %j', async (vault) => {
    const store = toSmb({ smb: mockSmb() })
    await expect(store.put(vault, 'c', 'r', env(1))).rejects.toThrow(/vault must be a single path segment/)
  })

  it.each(badNames)('refuses collection %j', async (collection) => {
    const store = toSmb({ smb: mockSmb() })
    await expect(store.put('v', collection, 'r', env(1))).rejects.toThrow(/collection must be a single path segment/)
  })

  it.each(badIds)('refuses id %j on put, get and delete', async (id) => {
    const store = toSmb({ smb: mockSmb() })
    await expect(store.put('v', 'c', id, env(1))).rejects.toThrow(/record id/)
    await expect(store.get('v', 'c', id)).rejects.toThrow(/record id/)
    await expect(store.delete('v', 'c', id)).rejects.toThrow(/record id/)
  })

  it('accepts a slash-bearing id (hub index side-cars) and ordinary punctuation', async () => {
    const store = toSmb({ smb: mockSmb() })
    for (const id of ['_idx/email/r1', 'with space.and.dots']) {
      await store.put('v', 'c', id, env(1))
      expect(await store.get('v', 'c', id)).toEqual(env(1))
    }
  })

  it('saveAll does not follow a listing that names ".."', async () => {
    const handle = mockSmb()
    // A server whose listing includes the dot entries and resolves '..'.
    const readdir = handle.readdir.bind(handle)
    const unlink = handle.unlink.bind(handle)
    handle.readdir = async (path: string) => ['.', '..', ...(await readdir(posix.normalize(path)))]
    handle.unlink = async (path: string) => unlink(posix.normalize(path))
    const store = toSmb({ smb: handle })
    await store.put('v1', 'c1', 'r', env(1))
    await handle.writeFile('noydb/stray.json', '{}')
    await store.saveAll('v1', {})
    expect(handle.files.has('noydb/stray.json')).toBe(true)
  })
})
