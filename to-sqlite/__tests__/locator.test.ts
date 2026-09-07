import { describe, expect, it } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { createStoreLocator } from '@noy-db/hub/to'
import { runStoreConformanceTests } from '@noy-db/test-adapter-conformance'
import { registerSqliteStore, sqliteStoreDescriptor } from '../src/index.js'

// noy-db-to#58 — opaque-client tier: a credentialless, JSON-serializable
// descriptor reconstructs the store via the locator; the live connection
// (this store has no client library of its own) rides the device-local
// `binding.client` slot, never the descriptor.

describe('to-sqlite — store-locator descriptor (#58)', () => {
  it('resolves a working NoydbStore from a descriptor', async () => {
    const locator = createStoreLocator()
    registerSqliteStore(locator)
    const descriptor = sqliteStoreDescriptor({ file: 'app.db', table: 'noydb_envelopes' })
    const store = await locator.resolve(descriptor, { binding: { client: new DatabaseSync(':memory:') } })
    const envelope = { _noydb: 1 as const, _v: 1, _ts: new Date().toISOString(), _iv: 'i', _data: 'ZA==' }
    await store.put('v', 'c', 'a', envelope)
    expect((await store.get('v', 'c', 'a'))?._v).toBe(1)
  })

  it('descriptor is JSON-serializable and credentialless by construction', () => {
    const descriptor = sqliteStoreDescriptor(
      { file: 'app.db', table: 'custom_table' },
      { autoMigrate: false },
    )
    expect(JSON.parse(JSON.stringify(descriptor))).toEqual(descriptor)
    expect(descriptor).toEqual({
      kind: 'sqlite',
      class: 'local',
      address: { file: 'app.db', table: 'custom_table' },
      options: { autoMigrate: false },
    })
  })

  it('an unregistered kind fails resolve loudly', () => {
    const locator = createStoreLocator()
    expect(() => locator.resolve(sqliteStoreDescriptor({ table: 'noydb_envelopes' }))).toThrow()
  })

  it('resolving without binding.client throws the Rule 2 error', () => {
    const locator = createStoreLocator()
    registerSqliteStore(locator)
    const descriptor = sqliteStoreDescriptor({ table: 'noydb_envelopes' })
    expect(() => locator.resolve(descriptor, {})).toThrow(/binding\.client/)
  })

  it('address.table maps to tableName, not the default', async () => {
    const locator = createStoreLocator()
    registerSqliteStore(locator)
    const client = new DatabaseSync(':memory:')
    const descriptor = sqliteStoreDescriptor({ file: 'app.db', table: 'custom_table' })
    const store = await locator.resolve(descriptor, { binding: { client } })
    const envelope = { _noydb: 1 as const, _v: 1, _ts: new Date().toISOString(), _iv: 'i', _data: 'ZA==' }
    await store.put('v', 'c', 'a', envelope)
    const tables = (client.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[])
      .map(r => r.name)
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

describe('to-sqlite — descriptor.options cannot shadow binding-owned slots (#69)', () => {
  it('a tableName smuggled through options never reaches the store', async () => {
    const locator = createStoreLocator()
    registerSqliteStore(locator)
    const client = new DatabaseSync(':memory:')
    const poisoned = await locator.resolve(
      { ...sqliteStoreDescriptor({}), options: { tableName: 'attacker_owned' } },
      { binding: { client } },
    )
    const clean = await locator.resolve(sqliteStoreDescriptor({}), { binding: { client } })
    const envelope = { _noydb: 1 as const, _v: 1, _ts: new Date().toISOString(), _iv: 'i', _data: 'ZA==' }
    await poisoned.put('v', 'c', 'a', envelope)
    // Same default table on both sides ⇒ the shadow never landed.
    expect((await clean.get('v', 'c', 'a'))?._v).toBe(1)
  })

  it('an unknown options key is ignored, not forwarded', async () => {
    const locator = createStoreLocator()
    registerSqliteStore(locator)
    const store = await locator.resolve(
      { ...sqliteStoreDescriptor({}), options: { nonsense: true, tableName: undefined } },
      { binding: { client: new DatabaseSync(':memory:') } },
    )
    const envelope = { _noydb: 1 as const, _v: 1, _ts: new Date().toISOString(), _iv: 'i', _data: 'ZA==' }
    await store.put('v', 'c', 'a', envelope)
    expect((await store.get('v', 'c', 'a'))?._v).toBe(1)
  })
})

// ─── Full conformance suite against a descriptor-resolved store ──────
runStoreConformanceTests('to-sqlite (descriptor-resolved via store locator)', async () => {
  const locator = createStoreLocator()
  registerSqliteStore(locator)
  return locator.resolve(sqliteStoreDescriptor({}), {
    binding: { client: new DatabaseSync(':memory:') },
  })
})
