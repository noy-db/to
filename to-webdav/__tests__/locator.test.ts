import { describe, expect, it } from 'vitest'
import { createStoreLocator } from '@noy-db/hub/to'
import { runStoreConformanceTests } from '@noy-db/test-adapter-conformance'
import { registerWebdavStore, webdavStoreDescriptor } from '../src/index.js'
import { fakeDav } from './_fake-dav.js'

// noy-db-to#56 / noy-db#945 — the `lan`-class model citizen: a
// credentialless, JSON-serializable descriptor reconstructs the store via
// the locator; transport overrides (a custom fetch wrapper) ride the
// device-local `binding` slot, never the descriptor.

describe('to-webdav — store-locator descriptor (#56)', () => {
  it('resolves a working NoydbStore from a descriptor', async () => {
    const locator = createStoreLocator()
    registerWebdavStore(locator)
    const descriptor = webdavStoreDescriptor({ baseUrl: 'https://dav.example.com', prefix: 'noydb' })
    const store = await locator.resolve(descriptor, { binding: { fetch: fakeDav().fetch } })
    const envelope = { _noydb: 1 as const, _v: 1, _ts: new Date().toISOString(), _iv: 'i', _data: 'ZA==' }
    await store.put('v', 'c', 'a', envelope)
    expect((await store.get('v', 'c', 'a'))?._v).toBe(1)
  })

  it('descriptor is JSON-serializable and credentialless by construction', () => {
    const descriptor = webdavStoreDescriptor(
      { baseUrl: 'https://dav.example.com', prefix: 'p' },
      { eagerMkcol: true },
    )
    expect(JSON.parse(JSON.stringify(descriptor))).toEqual(descriptor)
    expect(descriptor).toEqual({
      kind: 'webdav',
      class: 'lan',
      address: { baseUrl: 'https://dav.example.com', prefix: 'p' },
      options: { eagerMkcol: true },
    })
  })

  it('an unregistered kind fails resolve loudly', () => {
    const locator = createStoreLocator()
    expect(() => locator.resolve(webdavStoreDescriptor({ baseUrl: 'https://x' }))).toThrow()
  })

  it('forwards the descriptor address into the URL the store actually requests (#58)', async () => {
    const locator = createStoreLocator()
    registerWebdavStore(locator)
    const dav = fakeDav()
    const seenUrls: string[] = []
    const fetchSpy: typeof fetch = (async (url: unknown, init?: RequestInit) => {
      seenUrls.push(String(url))
      return dav.fetch(url as RequestInfo, init)
    }) as typeof fetch
    const descriptor = webdavStoreDescriptor({ baseUrl: 'https://dav.example.com/custom-root', prefix: 'custom-prefix' })
    const store = await locator.resolve(descriptor, { binding: { fetch: fetchSpy } })
    const envelope = { _noydb: 1 as const, _v: 1, _ts: new Date().toISOString(), _iv: 'i', _data: 'ZA==' }
    await store.put('v', 'c', 'a', envelope)
    const putUrl = seenUrls.find(u => u.includes('/a.json'))
    expect(putUrl).toContain('dav.example.com/custom-root')
    expect(putUrl).toContain('custom-prefix')
  })
})

// ─── Full conformance suite against a descriptor-resolved store ──────
runStoreConformanceTests('to-webdav (descriptor-resolved via store locator)', async () => {
  const locator = createStoreLocator()
  registerWebdavStore(locator)
  return locator.resolve(webdavStoreDescriptor({ baseUrl: 'https://dav.example.com' }), {
    binding: { fetch: fakeDav().fetch },
  })
})

// ─── noy-db-to#69 — descriptor.options may only set declared keys ─────
//
// Two holes here, both from `{ ...address, ...options }`: `prefix` (an
// address field) and `headers` (a BINDING field, applied conditionally).
// `headers` is the one the #69 write-up predicted would eventually open —
// a plain JSON object, so unlike a `fetch` function it survives a pod
// round-trip and reaches a real consumer.

describe('to-webdav — descriptor.options cannot shadow address/binding slots (#69)', () => {
  it('a prefix smuggled through options never overrides the address prefix', async () => {
    const locator = createStoreLocator()
    registerWebdavStore(locator)
    const dav = fakeDav()
    const address = { baseUrl: 'https://dav.example.com', prefix: 'tenant-a' }
    const poisoned = await locator.resolve(
      { ...webdavStoreDescriptor(address), options: { prefix: 'attacker' } },
      { binding: { fetch: dav.fetch } },
    )
    const clean = await locator.resolve(webdavStoreDescriptor(address), { binding: { fetch: dav.fetch } })
    const envelope = { _noydb: 1 as const, _v: 1, _ts: new Date().toISOString(), _iv: 'i', _data: 'ZA==' }
    await poisoned.put('v', 'c', 'a', envelope)
    expect((await clean.get('v', 'c', 'a'))?._v).toBe(1)
  })

  it('headers smuggled through options are never sent', async () => {
    const locator = createStoreLocator()
    registerWebdavStore(locator)
    const dav = fakeDav()
    const seen: Array<Record<string, string>> = []
    const fetchSpy: typeof fetch = (async (url: unknown, init?: RequestInit) => {
      seen.push({ ...(init?.headers as Record<string, string> | undefined) })
      return dav.fetch(url as RequestInfo, init)
    }) as typeof fetch
    const store = await locator.resolve(
      {
        ...webdavStoreDescriptor({ baseUrl: 'https://dav.example.com' }),
        options: { headers: { authorization: 'Bearer attacker-token' } },
      },
      { binding: { fetch: fetchSpy } },
    )
    const envelope = { _noydb: 1 as const, _v: 1, _ts: new Date().toISOString(), _iv: 'i', _data: 'ZA==' }
    await store.put('v', 'c', 'a', envelope)
    expect(seen.length).toBeGreaterThan(0)
    for (const headers of seen) {
      const values = Object.values(headers).map(v => String(v))
      expect(values).not.toContain('Bearer attacker-token')
    }
  })
})
