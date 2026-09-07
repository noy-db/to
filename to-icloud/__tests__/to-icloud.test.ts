import { describe, expect, it, beforeEach } from 'vitest'
import { PodVersionConflictError } from '@noy-db/hub'
import { mockFs } from './_mock.js'
import { toIcloud } from '../src/index.js'

/**
 * In-memory fake file system with iCloud-style eviction semantics.
 * Each file can be "offloaded" — readFile then returns null, but a
 * `.icloud` stub exists. `triggerDownload` simulates the macOS
 * `brctl download` call bringing the file back.
 */
function bytes(s: string): Uint8Array { return new TextEncoder().encode(s) }

describe('@noy-db/to-icloud', () => {
  const dir = '/Users/alice/Library/Mobile Documents/NoyDB'
  let fs: ReturnType<typeof mockFs>

  beforeEach(() => { fs = mockFs() })

  it('kind is "bundle" and name is "icloud"', () => {
    const store = toIcloud({ folder: dir, fs })
    expect(store.kind).toBe('bundle')
    expect(store.name).toBe('icloud')
  })

  it('readBundle returns null when no bundle exists', async () => {
    const store = toIcloud({ folder: dir, fs })
    expect(await store.readBundle('acme')).toBeNull()
  })

  it('writeBundle + readBundle round-trip', async () => {
    const store = toIcloud({ folder: dir, fs })
    const payload = bytes('hello-vault')
    const { version } = await store.writeBundle('acme', payload, null)
    expect(version).toBeTruthy()

    const read = await store.readBundle('acme')
    expect(read).not.toBeNull()
    expect(new TextDecoder().decode(read!.bytes)).toBe('hello-vault')
    expect(read!.version).toBe(version)
  })

  it('writeBundle throws on version mismatch', async () => {
    const store = toIcloud({ folder: dir, fs })
    await store.writeBundle('acme', bytes('v1'), null)
    await expect(store.writeBundle('acme', bytes('v2'), 'wrong-version'))
      .rejects.toBeInstanceOf(PodVersionConflictError)
  })

  it('writeBundle raises on detected conflict file', async () => {
    const store = toIcloud({ folder: dir, fs })
    await store.writeBundle('acme', bytes('v1'), null)

    // Inject a conflict file as iCloud would.
    fs.files.set(`${dir}/acme (conflicted copy 2026-04-23).noydb`, {
      bytes: bytes('rival-v1'), mtime: 1_700_000_500_000, size: 8,
    })
    await expect(store.writeBundle('acme', bytes('v2'), 'stale'))
      .rejects.toBeInstanceOf(PodVersionConflictError)
  })

  it('deleteBundle is idempotent', async () => {
    const store = toIcloud({ folder: dir, fs })
    await store.writeBundle('acme', bytes('v1'), null)
    await store.deleteBundle('acme')
    await expect(store.deleteBundle('acme')).resolves.toBeUndefined()
    expect(await store.readBundle('acme')).toBeNull()
  })

  it('listBundles enumerates vault bundles excluding .icloud stubs', async () => {
    const store = toIcloud({ folder: dir, fs })
    await store.writeBundle('acme', bytes('v1'), null)
    await store.writeBundle('globex', bytes('v1'), null)
    // Offload the acme file — the stub should be filtered out of list.
    fs.offload(`${dir}/acme.noydb`)

    const list = await store.listBundles()
    const ids = list.map(b => b.vaultId).sort()
    expect(ids).toEqual(['globex']) // acme is offloaded, list shouldn't include stubs
  })

  it('custom suffix is honored throughout', async () => {
    const store = toIcloud({ folder: dir, fs, suffix: '.nvault' })
    await store.writeBundle('acme', bytes('v1'), null)
    expect([...fs.files.keys()]).toEqual([`${dir}/acme.nvault`])
    const list = await store.listBundles()
    expect(list[0]!.vaultId).toBe('acme')
  })
})
