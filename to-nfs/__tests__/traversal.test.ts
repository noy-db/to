import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { EncryptedEnvelope } from '@noy-db/hub'
import type { MountDetector } from '../src/index.js'
import { toNfs } from '../src/index.js'

// noy-db/family#148 — the segment rule ruled on family#133: vault and
// collection are single names; an id may carry '/', but no component of it
// may be empty, '.' or '..'; no backslash or NUL anywhere. Real fs: the mount
// is a subdirectory of a fresh tmp dir, so an escape would land beside it.

const cleanDetector: MountDetector = async () => ({ exists: true, fstype: 'nfs4', options: ['rw', 'noac'] })

function env(v: number): EncryptedEnvelope {
  return {
    _noydb: 1, _v: v, _ts: new Date(1700000000000 + v * 1000).toISOString(),
    _iv: 'aaaa', _data: `ciphertext-${v}`, _by: 'alice',
  }
}

const badNames = ['', '.', '..', 'a/b', 'a\\b', 'a\0b']
const badIds = ['', '.', '..', '../x', 'a/../b', '/x', 'x/', 'a//b', 'a\\b', 'a\0b']

let outer: string
afterEach(async () => { await rm(outer, { recursive: true, force: true }) })

async function mount() {
  outer = await mkdtemp(join(tmpdir(), 'noydb-nfs-traversal-'))
  return toNfs({ mountPath: join(outer, 'mount'), mountDetector: cleanDetector })
}

describe('@noy-db/to-nfs path segments', () => {
  it.each(badNames)('refuses vault %j', async (vault) => {
    const store = await mount()
    await expect(store.put(vault, 'c', 'r', env(1))).rejects.toThrow(/vault must be a single path segment/)
  })

  it.each(badNames)('refuses collection %j', async (collection) => {
    const store = await mount()
    await expect(store.put('v', collection, 'r', env(1))).rejects.toThrow(/collection must be a single path segment/)
  })

  it.each(badIds)('refuses id %j on put, get and delete', async (id) => {
    const store = await mount()
    await expect(store.put('v', 'c', id, env(1))).rejects.toThrow(/record id/)
    await expect(store.get('v', 'c', id)).rejects.toThrow(/record id/)
    await expect(store.delete('v', 'c', id)).rejects.toThrow(/record id/)
  })

  it('a ".." vault writes nothing beside the mount', async () => {
    const store = await mount()
    await store.put('..', 'c', 'escaped', env(1)).catch(() => undefined)
    expect((await readdir(outer)).filter(e => e !== 'mount')).toEqual([])
  })

  it('accepts a slash-bearing id (hub index side-cars) and ordinary punctuation', async () => {
    const store = await mount()
    for (const id of ['_idx/email/r1', 'with space.and.dots']) {
      await store.put('v', 'c', id, env(1))
      expect(await store.get('v', 'c', id)).toEqual(env(1))
    }
  })
})
