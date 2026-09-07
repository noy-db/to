import { describe, expect, it } from 'vitest'
import { createStoreLocator } from '@noy-db/hub/to'
import { runStoreConformanceTests } from '@noy-db/test-adapter-conformance'
import { registerCloudflareD1Store, cloudflareD1StoreDescriptor } from '../src/index.js'
import { d1OverNodeSqlite } from './_engine.js'

// noy-db-to#58 — opaque-client tier: a credentialless, JSON-serializable
// descriptor reconstructs the store via the locator; the live connection
// (this store has no client library of its own) rides the device-local
// `binding.client` slot, never the descriptor.

describe('to-cloudflare-d1 — store-locator descriptor (#58)', () => {
  it('resolves a working NoydbStore from a descriptor', async () => {
    const locator = createStoreLocator()
    registerCloudflareD1Store(locator)
    const descriptor = cloudflareD1StoreDescriptor({ binding: 'DB', database: 'app', table: 'noydb_envelopes' })
    const store = await locator.resolve(descriptor, { binding: { client: d1OverNodeSqlite() } })
    const envelope = { _noydb: 1 as const, _v: 1, _ts: new Date().toISOString(), _iv: 'i', _data: 'ZA==' }
    await store.put('v', 'c', 'a', envelope)
    expect((await store.get('v', 'c', 'a'))?._v).toBe(1)
  })

  it('descriptor is JSON-serializable and credentialless by construction', () => {
    const descriptor = cloudflareD1StoreDescriptor(
      { binding: 'DB', database: 'app', table: 'custom_table' },
      { autoMigrate: false },
    )
    expect(JSON.parse(JSON.stringify(descriptor))).toEqual(descriptor)
    expect(descriptor).toEqual({
      kind: 'cloudflare-d1',
      class: 'cloud',
      address: { binding: 'DB', database: 'app', table: 'custom_table' },
      options: { autoMigrate: false },
    })
  })

  it('an unregistered kind fails resolve loudly', () => {
    const locator = createStoreLocator()
    expect(() => locator.resolve(cloudflareD1StoreDescriptor({ table: 'noydb_envelopes' }))).toThrow()
  })

  it('resolving without binding.client throws the Rule 2 error', () => {
    const locator = createStoreLocator()
    registerCloudflareD1Store(locator)
    const descriptor = cloudflareD1StoreDescriptor({ table: 'noydb_envelopes' })
    expect(() => locator.resolve(descriptor, {})).toThrow(/binding\.client/)
  })

  it('address.table maps to tableName, not the default', async () => {
    const locator = createStoreLocator()
    registerCloudflareD1Store(locator)
    const client = d1OverNodeSqlite()
    const descriptor = cloudflareD1StoreDescriptor({ binding: 'DB', database: 'app', table: 'custom_table' })
    const store = await locator.resolve(descriptor, { binding: { client } })
    const envelope = { _noydb: 1 as const, _v: 1, _ts: new Date().toISOString(), _iv: 'i', _data: 'ZA==' }
    await store.put('v', 'c', 'a', envelope)
    const { results } = await client.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all<{ name: string }>()
    const tables = results.map(r => r.name)
    expect(tables).toContain('custom_table')
    expect(tables).not.toContain('noydb_envelopes')
  })
})

// ─── noy-db-to#69 — descriptor.options may only set declared keys ─────
//
// Every factory used to build its store options by spreading the
// descriptor's unchecked `options` bag. Where the binding- or
// address-owned key was applied CONDITIONALLY, a matching `options` key
// survived and won. The factories now destructure the declared
// `DescriptorOptions` fields, so an undeclared key cannot reach the store at all.

describe('to-cloudflare-d1 — descriptor.options cannot shadow binding-owned slots (#69)', () => {
  it('a tableName smuggled through options never reaches the store', async () => {
    const locator = createStoreLocator()
    registerCloudflareD1Store(locator)
    const client = d1OverNodeSqlite()
    const poisoned = await locator.resolve(
      { ...cloudflareD1StoreDescriptor({}), options: { tableName: 'attacker_owned' } },
      { binding: { client } },
    )
    const clean = await locator.resolve(cloudflareD1StoreDescriptor({}), { binding: { client } })
    const envelope = { _noydb: 1 as const, _v: 1, _ts: new Date().toISOString(), _iv: 'i', _data: 'ZA==' }
    await poisoned.put('v', 'c', 'a', envelope)
    // Same default table on both sides ⇒ the shadow never landed.
    expect((await clean.get('v', 'c', 'a'))?._v).toBe(1)
  })

  it('an unknown options key is ignored, not forwarded', async () => {
    const locator = createStoreLocator()
    registerCloudflareD1Store(locator)
    const store = await locator.resolve(
      { ...cloudflareD1StoreDescriptor({}), options: { nonsense: true, tableName: undefined } },
      { binding: { client: d1OverNodeSqlite() } },
    )
    const envelope = { _noydb: 1 as const, _v: 1, _ts: new Date().toISOString(), _iv: 'i', _data: 'ZA==' }
    await store.put('v', 'c', 'a', envelope)
    expect((await store.get('v', 'c', 'a'))?._v).toBe(1)
  })
})

// ─── Full conformance suite against a descriptor-resolved store ──────
runStoreConformanceTests('to-cloudflare-d1 (descriptor-resolved via store locator)', async () => {
  const locator = createStoreLocator()
  registerCloudflareD1Store(locator)
  return locator.resolve(cloudflareD1StoreDescriptor({}), {
    binding: { client: d1OverNodeSqlite() },
  })
})
