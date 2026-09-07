import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createStoreLocator } from '@noy-db/hub/to'
import { runStoreConformanceTests } from '@noy-db/test-adapter-conformance'
import type { MountDetector } from '../src/index.js'
import { registerNfsStore, nfsStoreDescriptor } from '../src/index.js'

// noy-db-to#58 — binding-slot tier: a credentialless, JSON-serializable
// descriptor reconstructs the store via the locator; the live mount point
// (device-local, since which export is mounted where differs per machine)
// rides `binding.mountPath`, never the descriptor. `server`/`export` on
// the descriptor's `address` are identity-only — the factory does not
// consume them, so there is nothing to forward from `address`; the
// forwarding test below instead asserts `binding.mountPath` reaches the
// store.

const cleanDetector: MountDetector = async () => ({ exists: true, fstype: 'nfs4', options: ['rw', 'noac'] })

describe('to-nfs — store-locator descriptor (#58)', () => {
  let dir: string
  beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'nfs-locator-')) })
  afterEach(async () => { await rm(dir, { recursive: true, force: true }) })

  it('resolves a working NoydbStore from a descriptor', async () => {
    const locator = createStoreLocator()
    registerNfsStore(locator)
    const descriptor = nfsStoreDescriptor({ server: 'nas.local', export: '/exports/vaults' })
    const store = await locator.resolve(descriptor, { binding: { mountPath: dir, mountDetector: cleanDetector } })
    const envelope = { _noydb: 1 as const, _v: 1, _ts: new Date().toISOString(), _iv: 'i', _data: 'ZA==' }
    await store.put('v', 'c', 'a', envelope)
    expect((await store.get('v', 'c', 'a'))?._v).toBe(1)
  })

  it('descriptor is JSON-serializable and credentialless by construction', () => {
    const descriptor = nfsStoreDescriptor(
      { server: 'nas.local', export: '/exports/vaults' },
      { onNolock: 'error' },
    )
    expect(JSON.parse(JSON.stringify(descriptor))).toEqual(descriptor)
    expect(descriptor).toEqual({
      kind: 'nfs',
      class: 'lan',
      address: { server: 'nas.local', export: '/exports/vaults' },
      options: { onNolock: 'error' },
    })
  })

  it('an unregistered kind fails resolve loudly', () => {
    const locator = createStoreLocator()
    expect(() => locator.resolve(nfsStoreDescriptor({ server: 'nas.local' }))).toThrow()
  })

  it('resolving without binding.mountPath throws the guard error', () => {
    const locator = createStoreLocator()
    registerNfsStore(locator)
    const descriptor = nfsStoreDescriptor({ server: 'nas.local' })
    expect(() => locator.resolve(descriptor, {})).toThrow(/binding\.mountPath/)
  })

  // `server`/`export` are identity-only and deliberately never forwarded —
  // this asserts the actually-forwarded slot, `binding.mountPath`, instead.
  it('binding.mountPath reaches the store — address is deliberately not forwarded', async () => {
    const locator = createStoreLocator()
    registerNfsStore(locator)
    const descriptor = nfsStoreDescriptor({ server: 'nas.local', export: '/exports/vaults' })
    const store = await locator.resolve(descriptor, { binding: { mountPath: dir, mountDetector: cleanDetector } })
    const envelope = { _noydb: 1 as const, _v: 1, _ts: new Date().toISOString(), _iv: 'i', _data: 'ZA==' }
    await store.put('v', 'c', 'a', envelope)
    const entries = await readdir(dir, { recursive: true }).catch(() => [] as string[])
    expect(entries.length).toBeGreaterThan(0)
  })
})

// ─── Full conformance suite against a descriptor-resolved store ──────
const createdDirs: string[] = []
runStoreConformanceTests(
  'to-nfs (descriptor-resolved via store locator)',
  async () => {
    const locator = createStoreLocator()
    registerNfsStore(locator)
    const mountPath = await mkdtemp(join(tmpdir(), 'noydb-nfs-locator-conformance-'))
    createdDirs.push(mountPath)
    const descriptor = nfsStoreDescriptor({})
    return locator.resolve(descriptor, { binding: { mountPath, mountDetector: cleanDetector } })
  },
  async () => {
    await Promise.all(createdDirs.map(d => rm(d, { recursive: true, force: true })))
  },
)

// ─── noy-db-to#69 — descriptor.options may only set declared keys ─────
//
// The #69 write-up's second named case. `binding.mountDetector` is
// OPTIONAL, so its conditional spread left an `options.mountDetector` key
// alive — and that detector is what produces the `nolock` / `noac` /
// wrong-fstype safety diagnostics. A descriptor supplying its own would
// have silently disabled every warning this store exists to raise.

describe('to-nfs — descriptor.options cannot shadow binding-owned slots (#69)', () => {
  it('a mountDetector smuggled through options is never consulted', async () => {
    const locator = createStoreLocator()
    registerNfsStore(locator)
    let hostileCalls = 0
    const hostileDetector: MountDetector = async () => {
      hostileCalls++
      return { exists: true, fstype: 'nfs4', options: ['rw', 'noac'] }
    }
    const dir = await mkdtemp(join(tmpdir(), 'noydb-nfs-69-'))
    try {
      // NO binding.mountDetector — the exact condition under which the
      // conditional spread used to let `options.mountDetector` through.
      const store = await locator.resolve(
        { ...nfsStoreDescriptor({}), options: { mountDetector: hostileDetector } },
        { binding: { mountPath: dir } },
      )
      const envelope = { _noydb: 1 as const, _v: 1, _ts: new Date().toISOString(), _iv: 'i', _data: 'ZA==' }
      await store.put('v', 'c', 'a', envelope)
      expect(hostileCalls).toBe(0)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('an unknown options key is ignored, not forwarded', async () => {
    const locator = createStoreLocator()
    registerNfsStore(locator)
    const dir = await mkdtemp(join(tmpdir(), 'noydb-nfs-69-unknown-'))
    try {
      const store = await locator.resolve(
        { ...nfsStoreDescriptor({}), options: { nonsense: true } },
        { binding: { mountPath: dir, mountDetector: cleanDetector } },
      )
      const envelope = { _noydb: 1 as const, _v: 1, _ts: new Date().toISOString(), _iv: 'i', _data: 'ZA==' }
      await store.put('v', 'c', 'a', envelope)
      expect((await store.get('v', 'c', 'a'))?._v).toBe(1)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})
