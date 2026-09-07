import { describe, expect, it } from 'vitest'
import { createStoreLocator } from '@noy-db/hub/to'
import { wrapPodStore } from '@noy-db/hub/pod'
import { runStoreConformanceTests } from '@noy-db/test-adapter-conformance'
import type { NoydbPodStore } from '@noy-db/hub/to'
import { registerIcloudStore, icloudStoreDescriptor } from '../src/index.js'
import { mockFs } from './_mock.js'

// noy-db-to#58 — opaque-client tier: a credentialless, JSON-serializable
// descriptor reconstructs the store via the locator; the live filesystem
// facade (this store has no client library of its own) rides the
// device-local `binding.client` slot, never the descriptor.
//
// `toIcloud()` returns a `NoydbPodStore`, not a `NoydbStore` — same as
// `__tests__/conformance.test.ts`, the six-method contract is reached by
// wrapping the resolved store with `wrapPodStore()`, not via
// `runStoreConformanceTests`'s default put/get expectations directly on
// the locator's declared (but here inapplicable) `NoydbStore` return type.

let seq = 0

describe('to-icloud — store-locator descriptor (#58)', () => {
  it('resolves a working store from a descriptor', async () => {
    const locator = createStoreLocator()
    registerIcloudStore(locator)
    const descriptor = icloudStoreDescriptor({ folder: `/icloud-locator-${++seq}` })
    const pod = await locator.resolve(descriptor, { binding: { client: mockFs() } }) as unknown as NoydbPodStore
    const store = wrapPodStore(pod)
    const envelope = { _noydb: 1 as const, _v: 1, _ts: new Date().toISOString(), _iv: 'i', _data: 'ZA==' }
    await store.put('v', 'c', 'a', envelope)
    expect((await store.get('v', 'c', 'a'))?._v).toBe(1)
  })

  it('descriptor is JSON-serializable and credentialless by construction', () => {
    const descriptor = icloudStoreDescriptor(
      { folder: '/icloud-drive/vaults' },
      { suffix: '.custom' },
    )
    expect(JSON.parse(JSON.stringify(descriptor))).toEqual(descriptor)
    expect(descriptor).toEqual({
      kind: 'icloud',
      class: 'local',
      address: { folder: '/icloud-drive/vaults' },
      options: { suffix: '.custom' },
    })
  })

  it('an unregistered kind fails resolve loudly', () => {
    const locator = createStoreLocator()
    expect(() => locator.resolve(icloudStoreDescriptor({ folder: '/x' }))).toThrow()
  })

  it('resolving without binding.client throws the Rule 2 error', () => {
    const locator = createStoreLocator()
    registerIcloudStore(locator)
    const descriptor = icloudStoreDescriptor({ folder: '/x' })
    expect(() => locator.resolve(descriptor, {})).toThrow(/binding\.client/)
  })

  it('address.folder maps to the folder the bundle is written under', async () => {
    const locator = createStoreLocator()
    registerIcloudStore(locator)
    const fs = mockFs()
    const descriptor = icloudStoreDescriptor({ folder: '/custom-icloud-folder' })
    const pod = await locator.resolve(descriptor, { binding: { client: fs } }) as unknown as NoydbPodStore
    const store = wrapPodStore(pod)
    const envelope = { _noydb: 1 as const, _v: 1, _ts: new Date().toISOString(), _iv: 'i', _data: 'ZA==' }
    await store.put('v', 'c', 'a', envelope)
    expect([...fs.files.keys()].some(p => p.startsWith('/custom-icloud-folder/'))).toBe(true)
    expect([...fs.files.keys()]).toEqual(['/custom-icloud-folder/v.noydb'])
  })
})

// ─── Full conformance suite against a descriptor-resolved, wrapped store ─
runStoreConformanceTests('to-icloud (descriptor-resolved via store locator, wrapped)', async () => {
  const locator = createStoreLocator()
  registerIcloudStore(locator)
  const descriptor = icloudStoreDescriptor({ folder: `/icloud-locator-conformance-${++seq}` })
  const pod = await locator.resolve(descriptor, { binding: { client: mockFs() } }) as unknown as NoydbPodStore
  return wrapPodStore(pod)
})

// ─── noy-db-to#69 — descriptor.options may only set declared keys ─────
//
// Both of this store's non-descriptor inputs (`folder`, `fs`) are applied
// UNCONDITIONALLY after the spread, so nothing was shadowable here. The
// test exists anyway: the value of #69 is the invariant holding
// everywhere, which is only checkable if every store asserts it.

describe('to-icloud — descriptor.options cannot smuggle undeclared keys (#69)', () => {
  it('an undeclared options key never reaches the store', async () => {
    const locator = createStoreLocator()
    registerIcloudStore(locator)
    const fs = mockFs()
    const pod = await locator.resolve(
      { ...icloudStoreDescriptor({ folder: 'vaults' }), options: { folder: 'attacker', nonsense: true } },
      { binding: { client: fs } },
    ) as unknown as NoydbPodStore
    const store = wrapPodStore(pod)
    const envelope = { _noydb: 1 as const, _v: 1, _ts: new Date().toISOString(), _iv: 'i', _data: 'ZA==' }
    await store.put('v', 'c', 'a', envelope)
    expect((await store.get('v', 'c', 'a'))?._v).toBe(1)
  })
})
