import { describe, expect, it, beforeEach } from 'vitest'
import { createStoreLocator } from '@noy-db/hub/to'
import { runStoreConformanceTests } from '@noy-db/test-adapter-conformance'
import { registerBrowserLocalStore, browserLocalStoreDescriptor } from '../src/index.js'

// noy-db-to#58 — the `browser`-class citizen: no binding, no credentials.

describe('to-browser-local — store-locator descriptor (#58)', () => {
  beforeEach(() => {
    localStorage.clear()
  })

  it('resolves a working NoydbStore from a descriptor', async () => {
    const locator = createStoreLocator()
    registerBrowserLocalStore(locator)
    const store = await locator.resolve(browserLocalStoreDescriptor({ prefix: 'lt' }))
    const envelope = { _noydb: 1 as const, _v: 1, _ts: new Date().toISOString(), _iv: 'i', _data: 'ZA==' }
    await store.put('v', 'c', 'a', envelope)
    expect((await store.get('v', 'c', 'a'))?._v).toBe(1)
  })

  it('descriptor is JSON-serializable and credentialless by construction', () => {
    const descriptor = browserLocalStoreDescriptor({ prefix: 'p' }, { obfuscate: true })
    expect(JSON.parse(JSON.stringify(descriptor))).toEqual(descriptor)
    expect(descriptor).toEqual({
      kind: 'browser-local',
      class: 'browser',
      address: { prefix: 'p' },
      options: { obfuscate: true },
    })
  })

  it('omits the options key entirely when no options are given', () => {
    expect(browserLocalStoreDescriptor({ prefix: 'p' })).toEqual({
      kind: 'browser-local',
      class: 'browser',
      address: { prefix: 'p' },
    })
  })

  // The descriptor's `options` slot is behaviourally transparent to the
  // conformance suite, so shape assertions alone would stay green if a
  // factory dropped `...options`. `obfuscate` is the one option with a
  // cheap observable effect — this is the pattern's behavioural anchor.
  it('descriptor options reach the store: obfuscate hashes the localStorage keys', async () => {
    const locator = createStoreLocator()
    registerBrowserLocalStore(locator)
    const store = await locator.resolve(browserLocalStoreDescriptor({ prefix: 'obf' }, { obfuscate: true }))
    const envelope = { _noydb: 1 as const, _v: 1, _ts: new Date().toISOString(), _iv: 'i', _data: 'ZA==' }
    await store.put('MyCompany', 'invoices', 'INV-001', envelope)

    const keys = Object.keys(localStorage)
    expect(keys.length).toBeGreaterThan(0)
    for (const key of keys) {
      expect(key).not.toContain('MyCompany')
      expect(key).not.toContain('invoices')
      expect(key).not.toContain('INV-001')
    }
    // …and the store still reads back through the hashed keys.
    expect((await store.get('MyCompany', 'invoices', 'INV-001'))?._v).toBe(1)
  })

  it('an unregistered kind fails resolve loudly', () => {
    const locator = createStoreLocator()
    expect(() => locator.resolve(browserLocalStoreDescriptor({ prefix: 'p' }))).toThrow()
  })

  it('forwards the descriptor prefix into the actual localStorage key (#58)', async () => {
    const locator = createStoreLocator()
    registerBrowserLocalStore(locator)
    const store = await locator.resolve(browserLocalStoreDescriptor({ prefix: 'custom-locator-prefix' }))
    const envelope = { _noydb: 1 as const, _v: 1, _ts: new Date().toISOString(), _iv: 'i', _data: 'ZA==' }
    await store.put('v', 'c', 'a', envelope)
    const keys = Object.keys(localStorage)
    expect(keys).toContain('custom-locator-prefix:v:c:a')
  })
})

// ─── Full conformance suite against a descriptor-resolved store ──────
runStoreConformanceTests(
  'to-browser-local (descriptor-resolved via store locator)',
  async () => {
    localStorage.clear()
    const locator = createStoreLocator()
    registerBrowserLocalStore(locator)
    return locator.resolve(browserLocalStoreDescriptor({ prefix: `desc-${Date.now()}` }))
  },
  async () => {
    localStorage.clear()
  },
)

// ─── noy-db-to#69 — descriptor.options may only set declared keys ─────
// `{ ...address, ...options }` let an `options.prefix` win over the
// address's — and the prefix is the whole localStorage key namespace.

describe('to-browser-local — descriptor.options cannot shadow address-owned slots (#69)', () => {
  beforeEach(() => { localStorage.clear() })

  it('a prefix smuggled through options never overrides the address prefix', async () => {
    const locator = createStoreLocator()
    registerBrowserLocalStore(locator)
    const poisoned = await locator.resolve(
      { ...browserLocalStoreDescriptor({ prefix: 'tenant-a' }), options: { prefix: 'attacker' } },
    )
    const envelope = { _noydb: 1 as const, _v: 1, _ts: new Date().toISOString(), _iv: 'i', _data: 'ZA==' }
    await poisoned.put('v', 'c', 'a', envelope)
    const keys = Object.keys(localStorage)
    expect(keys).toContain('tenant-a:v:c:a')
    expect(keys).not.toContain('attacker:v:c:a')
  })

  it('an unknown options key is ignored, not forwarded', async () => {
    const locator = createStoreLocator()
    registerBrowserLocalStore(locator)
    const store = await locator.resolve(
      { ...browserLocalStoreDescriptor({ prefix: 'unknown-key' }), options: { nonsense: true } },
    )
    const envelope = { _noydb: 1 as const, _v: 1, _ts: new Date().toISOString(), _iv: 'i', _data: 'ZA==' }
    await store.put('v', 'c', 'a', envelope)
    expect((await store.get('v', 'c', 'a'))?._v).toBe(1)
  })
})
