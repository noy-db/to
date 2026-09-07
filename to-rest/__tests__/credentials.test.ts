import { describe, expect, it } from 'vitest'
import type { StoreCredentials } from '@noy-db/hub/to'
import { toRest } from '../src/index.js'
import type { CapturedRequest } from './_harness.js'
import { restHarness } from './_harness.js'

const envelope = { _noydb: 1 as const, _v: 1, _ts: new Date().toISOString(), _iv: 'i', _data: 'ZA==' }

/** Every authorization value on the raw request, whatever its spelling. */
const authHeadersOf = (req: CapturedRequest): string[] =>
  Object.entries(req.headers)
    .filter(([k]) => k.toLowerCase() === 'authorization')
    .map(([, v]) => v)

describe('to-rest — credential broker (#58)', () => {
  it('sends a bearer token from a credential source', async () => {
    const store = toRest({
      baseUrl: 'https://vault.example.com',
      credentials: async () => ({ kind: 'token', token: 'test-key' }),
      fetch: restHarness().fetch,
    })
    await store.put('v', 'c', 'a', envelope)
    expect((await store.get('v', 'c', 'a'))?._v).toBe(1)
  })

  it('re-invokes the source on every request, so rolling tokens work', async () => {
    let calls = 0
    const store = toRest({
      baseUrl: 'https://vault.example.com',
      credentials: async () => {
        calls++
        return { kind: 'token', token: 'test-key' }
      },
      fetch: restHarness().fetch,
    })
    await store.put('v', 'c', 'a', envelope)
    await store.get('v', 'c', 'a')
    expect(calls).toBe(2)
  })

  it('credentials override an authorization header supplied via headers', async () => {
    const harness = restHarness()
    const store = toRest({
      baseUrl: 'https://vault.example.com',
      headers: { authorization: 'Bearer WRONG', 'x-tenant': 'acme' },
      credentials: async () => ({ kind: 'token', token: 'test-key' }),
      fetch: harness.fetch,
    })
    await store.put('v', 'c', 'a', envelope)
    expect((await store.get('v', 'c', 'a'))?._v).toBe(1)
    expect(authHeadersOf(harness.requests[0]!)).toEqual(['Bearer test-key'])
  })

  // Header names are case-insensitive on the wire; object spread is not.
  // A caller writing `Authorization` (the spelling the README and
  // to-webdav both use) must not end up with BOTH spellings on the
  // request — fetch's Headers would concatenate them into
  // "Bearer WRONG, Bearer test-key" and the server would 401.
  it('credentials override a capital-A Authorization header from headers', async () => {
    const harness = restHarness()
    const store = toRest({
      baseUrl: 'https://vault.example.com',
      headers: { Authorization: 'Bearer WRONG', 'X-Tenant': 'acme' },
      credentials: async () => ({ kind: 'token', token: 'test-key' }),
      fetch: harness.fetch,
    })
    await store.put('v', 'c', 'a', envelope)
    expect((await store.get('v', 'c', 'a'))?._v).toBe(1)

    const sent = harness.requests[0]!
    expect(authHeadersOf(sent)).toEqual(['Bearer test-key'])
    // …and the non-auth header still rides along, lowercased.
    expect(sent.headers['x-tenant']).toBe('acme')
  })

  it('a capital-C Content-Type from headers does not duplicate the default', async () => {
    const harness = restHarness()
    const store = toRest({
      baseUrl: 'https://vault.example.com',
      headers: { 'Content-Type': 'application/json; charset=utf-8', Authorization: 'Bearer test-key' },
      fetch: harness.fetch,
    })
    await store.put('v', 'c', 'a', envelope)

    const sent = harness.requests[0]!
    const contentTypes = Object.entries(sent.headers)
      .filter(([k]) => k.toLowerCase() === 'content-type')
      .map(([, v]) => v)
    expect(contentTypes).toEqual(['application/json; charset=utf-8'])
  })

  it('rejects a credential kind other than token', async () => {
    const store = toRest({
      baseUrl: 'https://vault.example.com',
      credentials: async () => ({ kind: 'aws', accessKeyId: 'k', secretAccessKey: 's' }) as StoreCredentials,
      fetch: restHarness().fetch,
    })
    await expect(store.get('v', 'c', 'a')).rejects.toThrow(/kind 'aws'/)
  })

  it('still works with a static authorization header and no credentials', async () => {
    const store = toRest({
      baseUrl: 'https://vault.example.com',
      headers: { authorization: 'Bearer test-key' },
      fetch: restHarness().fetch,
    })
    await store.put('v', 'c', 'a', envelope)
    expect((await store.get('v', 'c', 'a'))?._v).toBe(1)
  })
})
