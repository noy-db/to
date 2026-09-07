import { describe, expect, it } from 'vitest'
import { createStoreLocator } from '@noy-db/hub/to'
import { runStoreConformanceTests } from '@noy-db/test-adapter-conformance'
import { registerSupabaseStore, supabaseStoreDescriptor } from '../src/index.js'
import { mockClient } from '../../to-postgres/__tests__/_mock.js'

// noy-db-to#58 — opaque-client tier: a credentialless, JSON-serializable
// descriptor reconstructs the store via the locator; the live connection
// (this store has no client library of its own) rides the device-local
// `binding.client` slot, never the descriptor.
//
// Reuses to-postgres's extracted `_mock.ts` deliberately: `toSupabase()`
// delegates everything to `toPostgres()` over the same client contract.

describe('to-supabase — store-locator descriptor (#58)', () => {
  it('resolves a working NoydbStore from a descriptor', async () => {
    const locator = createStoreLocator()
    registerSupabaseStore(locator)
    const descriptor = supabaseStoreDescriptor({ projectRef: 'abcxyz', schema: 'public', table: 'noydb_envelopes' })
    const store = await locator.resolve(descriptor, { binding: { client: mockClient() } })
    const envelope = { _noydb: 1 as const, _v: 1, _ts: new Date().toISOString(), _iv: 'i', _data: 'ZA==' }
    await store.put('v', 'c', 'a', envelope)
    expect((await store.get('v', 'c', 'a'))?._v).toBe(1)
  })

  it('descriptor is JSON-serializable and credentialless by construction', () => {
    const descriptor = supabaseStoreDescriptor(
      { projectRef: 'abcxyz', schema: 'public', table: 'custom_table' },
      { autoMigrate: false },
    )
    expect(JSON.parse(JSON.stringify(descriptor))).toEqual(descriptor)
    expect(descriptor).toEqual({
      kind: 'supabase',
      class: 'cloud',
      address: { projectRef: 'abcxyz', schema: 'public', table: 'custom_table' },
      options: { autoMigrate: false },
    })
  })

  it('an unregistered kind fails resolve loudly', () => {
    const locator = createStoreLocator()
    expect(() => locator.resolve(supabaseStoreDescriptor({ table: 'noydb_envelopes' }))).toThrow()
  })

  it('resolving without binding.client throws the Rule 2 error', () => {
    const locator = createStoreLocator()
    registerSupabaseStore(locator)
    const descriptor = supabaseStoreDescriptor({ table: 'noydb_envelopes' })
    expect(() => locator.resolve(descriptor, {})).toThrow(/binding\.client/)
  })

  it('address.table maps to tableName, not the default', async () => {
    const locator = createStoreLocator()
    registerSupabaseStore(locator)
    const client = mockClient()
    const queries: string[] = []
    const spiedClient = {
      query: async <T,>(sql: string, params?: readonly unknown[]) => {
        queries.push(sql)
        return client.query<T>(sql, params)
      },
    }
    const descriptor = supabaseStoreDescriptor({ projectRef: 'abcxyz', table: 'custom_table' })
    const store = await locator.resolve(descriptor, { binding: { client: spiedClient } })
    const envelope = { _noydb: 1 as const, _v: 1, _ts: new Date().toISOString(), _iv: 'i', _data: 'ZA==' }
    await store.put('v', 'c', 'a', envelope)
    expect(queries.some(q => q.includes('custom_table'))).toBe(true)
    expect(queries.some(q => q.includes('noydb_envelopes'))).toBe(false)
  })
})

// ─── noy-db-to#69 — descriptor.options may only set declared keys ─────
//
// Every factory used to build its store options by spreading the
// descriptor's unchecked `options` bag. Where the binding- or
// address-owned key was applied CONDITIONALLY, a matching `options` key
// survived and won. The factories now destructure the declared
// `DescriptorOptions` fields, so an undeclared key cannot reach the store at all.

describe('to-supabase — descriptor.options cannot shadow binding-owned slots (#69)', () => {
  it('a tableName smuggled through options never reaches the store', async () => {
    const locator = createStoreLocator()
    registerSupabaseStore(locator)
    // The mock keys rows in a Map, not by table, so a read-back cannot see
    // the shadow — the emitted SQL is the only honest witness.
    const inner = mockClient()
    const sql: string[] = []
    const client = {
      query: <T,>(s: string, p?: readonly unknown[]) => { sql.push(s); return inner.query<T>(s, p) },
    }
    const poisoned = await locator.resolve(
      { ...supabaseStoreDescriptor({ projectRef: 'proj' }), options: { tableName: 'attacker_owned' } },
      { binding: { client } },
    )
    const envelope = { _noydb: 1 as const, _v: 1, _ts: new Date().toISOString(), _iv: 'i', _data: 'ZA==' }
    await poisoned.put('v', 'c', 'a', envelope)
    expect(sql.join(' ')).not.toContain('attacker_owned')
    expect(sql.join(' ')).toContain('noydb_envelopes')
  })

  it('an unknown options key is ignored, not forwarded', async () => {
    const locator = createStoreLocator()
    registerSupabaseStore(locator)
    const store = await locator.resolve(
      { ...supabaseStoreDescriptor({ projectRef: 'proj' }), options: { nonsense: true, tableName: undefined } },
      { binding: { client: mockClient() } },
    )
    const envelope = { _noydb: 1 as const, _v: 1, _ts: new Date().toISOString(), _iv: 'i', _data: 'ZA==' }
    await store.put('v', 'c', 'a', envelope)
    expect((await store.get('v', 'c', 'a'))?._v).toBe(1)
  })
})

// ─── Full conformance suite against a descriptor-resolved store ──────
runStoreConformanceTests('to-supabase (descriptor-resolved via store locator)', async () => {
  const locator = createStoreLocator()
  registerSupabaseStore(locator)
  return locator.resolve(supabaseStoreDescriptor({}), {
    binding: { client: mockClient() },
  })
})
