import { describe, expect, it } from 'vitest'
import { createStoreLocator } from '@noy-db/hub/to'
import { runStoreConformanceTests } from '@noy-db/test-adapter-conformance'
import { registerRestStore, restStoreDescriptor } from '../src/index.js'
import { restHarness } from './_harness.js'

// noy-db-to#58 — `cloud` class. to-rest's options violate the credentialless
// rule twice (`fetch` is a function, `headers` carries the bearer token), so
// they are partitioned: transport into `binding`, auth onto the broker.

describe('to-rest — store-locator descriptor (#58)', () => {
  it('resolves a working NoydbStore from a descriptor', async () => {
    const locator = createStoreLocator()
    registerRestStore(locator)
    const descriptor = restStoreDescriptor({ baseUrl: 'https://vault.example.com' })
    const store = await locator.resolve(descriptor, {
      binding: { fetch: restHarness().fetch },
      credentials: async () => ({ kind: 'token', token: 'test-key' }),
    })
    const envelope = { _noydb: 1 as const, _v: 1, _ts: new Date().toISOString(), _iv: 'i', _data: 'ZA==' }
    await store.put('v', 'c', 'a', envelope)
    expect((await store.get('v', 'c', 'a'))?._v).toBe(1)
  })

  it('descriptor is JSON-serializable and credentialless by construction', () => {
    const descriptor = restStoreDescriptor({ baseUrl: 'https://vault.example.com' }, { timeoutMs: 5000 })
    expect(JSON.parse(JSON.stringify(descriptor))).toEqual(descriptor)
    expect(descriptor).toEqual({
      kind: 'rest',
      class: 'cloud',
      address: { baseUrl: 'https://vault.example.com' },
      options: { timeoutMs: 5000 },
    })
  })

  it('carries non-auth headers through the binding slot', async () => {
    const locator = createStoreLocator()
    registerRestStore(locator)
    const harness = restHarness()
    const store = await locator.resolve(restStoreDescriptor({ baseUrl: 'https://vault.example.com' }), {
      binding: { fetch: harness.fetch, headers: { 'x-tenant': 'acme' } },
      credentials: async () => ({ kind: 'token', token: 'test-key' }),
    })
    const envelope = { _noydb: 1 as const, _v: 1, _ts: new Date().toISOString(), _iv: 'i', _data: 'ZA==' }
    await store.put('v', 'c', 'a', envelope)
    expect((await store.get('v', 'c', 'a'))?._v).toBe(1)

    // The routing header must actually reach the wire, on every request —
    // a round-trip alone would stay green if the factory dropped it.
    expect(harness.requests).toHaveLength(2)
    for (const req of harness.requests) {
      expect(req.headers['x-tenant']).toBe('acme')
      expect(req.headers['authorization']).toBe('Bearer test-key')
    }
  })

  it('an unregistered kind fails resolve loudly', () => {
    const locator = createStoreLocator()
    expect(() => locator.resolve(restStoreDescriptor({ baseUrl: 'https://x' }))).toThrow()
  })

  it('forwards the descriptor baseUrl into the URL the store actually requests (#58)', async () => {
    const locator = createStoreLocator()
    registerRestStore(locator)
    const harness = restHarness()
    const store = await locator.resolve(
      restStoreDescriptor({ baseUrl: 'https://custom-locator-host.example.com' }),
      {
        binding: { fetch: harness.fetch },
        credentials: async () => ({ kind: 'token', token: 'test-key' }),
      },
    )
    const envelope = { _noydb: 1 as const, _v: 1, _ts: new Date().toISOString(), _iv: 'i', _data: 'ZA==' }
    await store.put('v', 'c', 'a', envelope)
    expect(harness.requests.length).toBeGreaterThan(0)
    for (const req of harness.requests) {
      expect(req.url).toContain('custom-locator-host.example.com')
    }
  })
})

// ─── Full conformance suite against a descriptor-resolved store ──────
runStoreConformanceTests('to-rest (descriptor-resolved via store locator)', async () => {
  const locator = createStoreLocator()
  registerRestStore(locator)
  return locator.resolve(restStoreDescriptor({ baseUrl: 'https://vault.example.com' }), {
    binding: { fetch: restHarness().fetch },
    credentials: async () => ({ kind: 'token', token: 'test-key' }),
  })
})

// ─── noy-db-to#69 — descriptor.options may only set declared keys ─────
//
// `headers` is a BINDING-owned field applied conditionally, so before #69
// an `options.headers` bag reached `toRest()` whenever the caller supplied
// no `binding.headers`. It is plain JSON — it survives a pod round-trip,
// which is exactly the case the write-up called "shadowable for real".

describe('to-rest — descriptor.options cannot shadow binding-owned slots (#69)', () => {
  it('headers smuggled through options are never sent', async () => {
    const locator = createStoreLocator()
    registerRestStore(locator)
    const harness = restHarness()
    const store = await locator.resolve(
      {
        ...restStoreDescriptor({ baseUrl: 'https://vault.example.com' }),
        options: { headers: { 'x-attacker': 'yes' } },
      },
      { binding: { fetch: harness.fetch }, credentials: async () => ({ kind: 'token', token: 'test-key' }) },
    )
    const envelope = { _noydb: 1 as const, _v: 1, _ts: new Date().toISOString(), _iv: 'i', _data: 'ZA==' }
    await store.put('v', 'c', 'a', envelope)
    expect(harness.requests.length).toBeGreaterThan(0)
    for (const req of harness.requests) {
      expect(Object.keys(req.headers).map(k => k.toLowerCase())).not.toContain('x-attacker')
    }
  })

  it('an unknown options key is ignored, not forwarded', async () => {
    const locator = createStoreLocator()
    registerRestStore(locator)
    const harness = restHarness()
    const store = await locator.resolve(
      { ...restStoreDescriptor({ baseUrl: 'https://vault.example.com' }), options: { nonsense: true } },
      { binding: { fetch: harness.fetch }, credentials: async () => ({ kind: 'token', token: 'test-key' }) },
    )
    const envelope = { _noydb: 1 as const, _v: 1, _ts: new Date().toISOString(), _iv: 'i', _data: 'ZA==' }
    await store.put('v', 'c', 'a', envelope)
    expect((await store.get('v', 'c', 'a'))?._v).toBe(1)
  })
})
