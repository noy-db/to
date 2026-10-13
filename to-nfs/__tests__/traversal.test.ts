import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { EncryptedEnvelope } from '@noy-db/hub'
import type { MountDetector } from '../src/index.js'
import { toNfs } from '../src/index.js'

// noy-db/family#148 — the segment rule ruled on family#133: vault and
// collection are single names; an id may carry '/', but no component of it
// may be empty, '.' or '..'; no backslash anywhere, and no NUL in a vault or
// collection. A NUL in an id is ENCODED, not refused (family#174). Real fs: the mount
// is a subdirectory of a fresh tmp dir, so an escape would land beside it.

const cleanDetector: MountDetector = async () => ({ exists: true, fstype: 'nfs4', options: ['rw', 'noac'] })

function env(v: number): EncryptedEnvelope {
  return {
    _noydb: 1, _v: v, _ts: new Date(1700000000000 + v * 1000).toISOString(),
    _iv: 'aaaa', _data: `ciphertext-${v}`, _by: 'alice',
  }
}

const badNames = ['', '.', '..', 'a/b', 'a\\b', 'a\0b']
const badIds = ['', '.', '..', '../x', 'a/../b', '/x', 'x/', 'a//b', 'a\\b']

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

  it('encodes `%` and NUL per component, so `a\\0b`, `a%00b` and `a%2500b` stay three records (family#174)', async () => {
    const store = await mount()
    const ids = ['a\0b', 'a%00b', 'a%2500b', 'p\0q/r%s']
    for (const [i, id] of ids.entries()) await store.put('v', 'c', id, env(i + 1))
    for (const [i, id] of ids.entries()) expect(await store.get('v', 'c', id)).toEqual(env(i + 1))
    expect((await store.list('v', 'c')).sort()).toEqual([...ids].sort())
    expect(Object.keys((await store.loadAll('v')).c!).sort()).toEqual([...ids].sort())
    expect((await readdir(join(outer, 'mount', 'v', 'c'))).sort()).toEqual(['a%00b.json', 'a%2500b.json', 'a%252500b.json', 'p%00q'])
    // `a%00b` on disk is where `a\0b` lives: dropping `a%00b` must not take it along.
    await store.delete('v', 'c', 'a%00b')
    expect(await store.get('v', 'c', 'a%00b')).toBeNull()
    expect(await store.get('v', 'c', 'a\0b')).toEqual(env(1))
  })

  it('still reads, lists, deletes and prunes a pre-encoding record whose id holds a `%` (family#174)', async () => {
    const store = await mount()
    await mkdir(join(outer, 'mount', 'v', 'c'), { recursive: true })
    await writeFile(join(outer, 'mount', 'v', 'c', 'x%3Ay.json'), JSON.stringify(env(1)))
    expect(await store.get('v', 'c', 'x%3Ay')).toEqual(env(1))
    expect(await store.list('v', 'c')).toEqual(['x%3Ay'])
    expect((await store.loadAll('v')).c).toEqual({ 'x%3Ay': env(1) })
    await writeFile(join(outer, 'mount', 'v', 'c', 'z%3Aw.json'), JSON.stringify(env(2)))
    await store.delete('v', 'c', 'x%3Ay')
    expect(await store.get('v', 'c', 'x%3Ay')).toBeNull()
    // A CAS write sees the legacy version, and the id then lists once.
    await store.put('v', 'c', 'z%3Aw', env(3), 2)
    expect(await store.get('v', 'c', 'z%3Aw')).toEqual(env(3))
    expect(await store.list('v', 'c')).toEqual(['z%3Aw'])
    await store.saveAll('v', { c: {} })
    expect(await readdir(join(outer, 'mount', 'v', 'c'))).toEqual([])
  })
})
