import { describe, expect, it } from 'vitest'
import { createStoreLocator } from '@noy-db/hub/to'
import { fakeRoot } from './fake-fs.js'
import { registerBrowserFsStore, browserFsStoreDescriptor } from '../src/index.js'

// noy-db-to#58 — the opaque-client tier, as to-smb uses it. A directory
// handle cannot be rebuilt from a serialized descriptor: it has to be
// recalled from IndexedDB or re-picked, so it arrives as a binding.

describe('to-browser-fs — store-locator descriptor', () => {
  it('resolves a working NoydbStore when the handle is supplied as a binding', async () => {
    const locator = createStoreLocator()
    registerBrowserFsStore(locator)

    const store = await locator.resolve(browserFsStoreDescriptor({ label: 'LAN' }), {
      binding: { handle: fakeRoot() },
    })

    const envelope = { _noydb: 1 as const, _v: 1, _ts: new Date().toISOString(), _iv: 'i', _data: 'ZA==' }
    await store.put('v', 'c', 'a', envelope)
    expect((await store.get('v', 'c', 'a'))?._v).toBe(1)
  })

  // The factory throws synchronously, as to-smb's does — resolve() does not
  // wrap it in a rejected promise.
  it('refuses to resolve without a handle, and says why', () => {
    const locator = createStoreLocator()
    registerBrowserFsStore(locator)

    expect(() => locator.resolve(browserFsStoreDescriptor({ label: 'LAN' })))
      .toThrow(/binding\.handle/)
  })

  it('descriptor is JSON-serializable and carries no handle', () => {
    const descriptor = browserFsStoreDescriptor({ label: 'LAN' }, { pretty: false })

    expect(JSON.parse(JSON.stringify(descriptor))).toEqual(descriptor)
    expect(descriptor).toEqual({
      kind: 'browser-fs',
      class: 'lan',
      address: { label: 'LAN' },
      options: { pretty: false },
    })
  })

  it('omits the options key entirely when no options are given', () => {
    expect(browserFsStoreDescriptor({ label: 'LAN' })).toEqual({
      kind: 'browser-fs',
      class: 'lan',
      address: { label: 'LAN' },
    })
  })

  it('descriptor options reach the store: pretty false writes compact JSON', async () => {
    const locator = createStoreLocator()
    registerBrowserFsStore(locator)
    const root = fakeRoot()

    const store = await locator.resolve(
      browserFsStoreDescriptor({ label: 'LAN' }, { pretty: false }),
      { binding: { handle: root } },
    )
    const envelope = { _noydb: 1 as const, _v: 1, _ts: '2026-08-11T00:00:00.000Z', _iv: 'i', _data: 'ZA==' }
    await store.put('v', 'c', 'a', envelope)

    expect(root.peek('v/c/a.json')).toBe(JSON.stringify(envelope))
  })
})
