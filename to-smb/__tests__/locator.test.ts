import { describe, expect, it } from 'vitest'
import { createStoreLocator } from '@noy-db/hub/to'
import { runStoreConformanceTests } from '@noy-db/test-adapter-conformance'
import { registerSmbStore, smbStoreDescriptor } from '../src/index.js'
import { mockSmb } from './_mock.js'

// noy-db-to#58 — opaque-client tier: a credentialless, JSON-serializable
// descriptor reconstructs the store via the locator; the live connection
// (this store has no client library of its own) rides the device-local
// `binding.client` slot, never the descriptor.

describe('to-smb — store-locator descriptor (#58)', () => {
  it('resolves a working NoydbStore from a descriptor', async () => {
    const locator = createStoreLocator()
    registerSmbStore(locator)
    const descriptor = smbStoreDescriptor({ host: 'nas.local', share: 'vaults', path: 'noydb' })
    const store = await locator.resolve(descriptor, { binding: { client: mockSmb() } })
    const envelope = { _noydb: 1 as const, _v: 1, _ts: new Date().toISOString(), _iv: 'i', _data: 'ZA==' }
    await store.put('v', 'c', 'a', envelope)
    expect((await store.get('v', 'c', 'a'))?._v).toBe(1)
  })

  it('descriptor is JSON-serializable and credentialless by construction', () => {
    const descriptor = smbStoreDescriptor(
      { host: 'nas.local', share: 'vaults', path: 'custom' },
      { name: 'my-smb' },
    )
    expect(JSON.parse(JSON.stringify(descriptor))).toEqual(descriptor)
    expect(descriptor).toEqual({
      kind: 'smb',
      class: 'lan',
      address: { host: 'nas.local', share: 'vaults', path: 'custom' },
      options: { name: 'my-smb' },
    })
  })

  it('an unregistered kind fails resolve loudly', () => {
    const locator = createStoreLocator()
    expect(() => locator.resolve(smbStoreDescriptor({}))).toThrow()
  })

  it('resolving without binding.client throws the Rule 2 error', () => {
    const locator = createStoreLocator()
    registerSmbStore(locator)
    const descriptor = smbStoreDescriptor({})
    expect(() => locator.resolve(descriptor, {})).toThrow(/binding\.client/)
  })

  it('address.path maps to remotePath, not the default', async () => {
    const locator = createStoreLocator()
    registerSmbStore(locator)
    const client = mockSmb()
    const descriptor = smbStoreDescriptor({ path: 'custom-root' })
    const store = await locator.resolve(descriptor, { binding: { client } })
    const envelope = { _noydb: 1 as const, _v: 1, _ts: new Date().toISOString(), _iv: 'i', _data: 'ZA==' }
    await store.put('v', 'c', 'a', envelope)
    expect([...client.files.keys()]).toContain('custom-root/v/c/a.json')
    expect([...client.files.keys()]).not.toContain('noydb/v/c/a.json')
  })
})

// ─── noy-db-to#69 — descriptor.options may only set declared keys ─────
//
// Every factory used to build its store options by spreading the
// descriptor's unchecked `options` bag. Where the binding- or
// address-owned key was applied CONDITIONALLY, a matching `options` key
// survived and won. The factories now destructure the declared
// `DescriptorOptions` fields, so an undeclared key cannot reach the store at all.

describe('to-smb — descriptor.options cannot shadow binding-owned slots (#69)', () => {
  it('a remotePath smuggled through options never reaches the store', async () => {
    const locator = createStoreLocator()
    registerSmbStore(locator)
    const client = mockSmb()
    const poisoned = await locator.resolve(
      { ...smbStoreDescriptor({}), options: { remotePath: 'attacker-root' } },
      { binding: { client } },
    )
    const envelope = { _noydb: 1 as const, _v: 1, _ts: new Date().toISOString(), _iv: 'i', _data: 'ZA==' }
    await poisoned.put('v', 'c', 'a', envelope)
    expect([...client.files.keys()]).toContain('noydb/v/c/a.json')
    expect([...client.files.keys()]).not.toContain('attacker-root/v/c/a.json')
  })

  it('an unknown options key is ignored, not forwarded', async () => {
    const locator = createStoreLocator()
    registerSmbStore(locator)
    const store = await locator.resolve(
      { ...smbStoreDescriptor({}), options: { nonsense: true } },
      { binding: { client: mockSmb() } },
    )
    const envelope = { _noydb: 1 as const, _v: 1, _ts: new Date().toISOString(), _iv: 'i', _data: 'ZA==' }
    await store.put('v', 'c', 'a', envelope)
    expect((await store.get('v', 'c', 'a'))?._v).toBe(1)
  })
})

// ─── Full conformance suite against a descriptor-resolved store ──────
runStoreConformanceTests('to-smb (descriptor-resolved via store locator)', async () => {
  const locator = createStoreLocator()
  registerSmbStore(locator)
  return locator.resolve(smbStoreDescriptor({}), {
    binding: { client: mockSmb() },
  })
})
