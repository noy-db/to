import { describe, it, expect } from 'vitest'
import type { StoreCredentials } from '@noy-db/hub/to'
import { toWebdav } from '../src/index.js'

// #479 credential-broker adoption for WebDAV (noy-db-to#11) — `credentials?:
// StoreCredentialSource` yielding `kind: 'token'`, injected per-request as
// `Authorization: Bearer <token>`. Unlike the AWS SDK there is no provider
// contract on the client side: the STORE owns the refresh — it caches the
// token and re-invokes the source when `expiresAt` is near/past.

function fetchRecorder(): {
  fetch: typeof fetch
  calls: Array<{ url: string; headers: Record<string, string> }>
} {
  const calls: Array<{ url: string; headers: Record<string, string> }> = []
  const impl = (async (url: unknown, init?: { headers?: Record<string, string> }) => {
    calls.push({ url: String(url), headers: { ...(init?.headers ?? {}) } })
    return new Response('{}', { status: 200 })
  }) as unknown as typeof fetch
  return { fetch: impl, calls }
}

function tokenSource(tokens: Array<{ token: string; expiresAt?: string }>): {
  source: () => Promise<StoreCredentials>
  invocations: () => number
} {
  let i = 0
  return {
    source: async () => {
      const t = tokens[Math.min(i++, tokens.length - 1)]!
      return { kind: 'token', ...t }
    },
    invocations: () => i,
  }
}

const FUTURE = new Date(Date.now() + 3_600_000).toISOString()
const PAST = new Date(Date.now() - 1_000).toISOString()

describe('to-webdav — credentials refresh hook', () => {
  it('injects Authorization: Bearer <token> on requests when credentials is supplied', async () => {
    const { fetch, calls } = fetchRecorder()
    const { source } = tokenSource([{ token: 'tok-1', expiresAt: FUTURE }])
    const store = toWebdav({ baseUrl: 'https://dav.example.com', fetch, credentials: source })

    await store.get('v', 'c', 'id1')

    expect(calls).toHaveLength(1)
    expect(calls[0]!.headers['Authorization']).toBe('Bearer tok-1')
  })

  it('caches the token across operations while unexpired (source invoked once)', async () => {
    const { fetch } = fetchRecorder()
    const { source, invocations } = tokenSource([{ token: 'tok-1', expiresAt: FUTURE }])
    const store = toWebdav({ baseUrl: 'https://dav.example.com', fetch, credentials: source })

    await store.get('v', 'c', 'a')
    await store.get('v', 'c', 'b')
    await store.delete('v', 'c', 'a')

    expect(invocations()).toBe(1)
  })

  it('re-invokes the source and uses the fresh token once expiresAt has passed', async () => {
    const { fetch, calls } = fetchRecorder()
    const { source, invocations } = tokenSource([
      { token: 'tok-old', expiresAt: PAST },
      { token: 'tok-new', expiresAt: FUTURE },
    ])
    const store = toWebdav({ baseUrl: 'https://dav.example.com', fetch, credentials: source })

    await store.get('v', 'c', 'a') // gets tok-old (already expired at issue time)
    await store.get('v', 'c', 'b') // must refresh → tok-new

    expect(invocations()).toBe(2)
    expect(calls[1]!.headers['Authorization']).toBe('Bearer tok-new')
  })

  it('treats a token without expiresAt as non-expiring (source invoked once)', async () => {
    const { fetch } = fetchRecorder()
    const { source, invocations } = tokenSource([{ token: 'tok-forever' }])
    const store = toWebdav({ baseUrl: 'https://dav.example.com', fetch, credentials: source })

    await store.get('v', 'c', 'a')
    await store.get('v', 'c', 'b')

    expect(invocations()).toBe(1)
  })

  it('rejects a non-token credential kind with a clear message', async () => {
    const { fetch } = fetchRecorder()
    const store = toWebdav({
      baseUrl: 'https://dav.example.com',
      fetch,
      credentials: async () => ({ kind: 'aws', accessKeyId: 'a', secretAccessKey: 's' }),
    })

    await expect(store.get('v', 'c', 'a')).rejects.toThrow(/kind 'aws'.*expected 'token'/)
  })

  it('credentials-derived Authorization overrides a static headers Authorization', async () => {
    const { fetch, calls } = fetchRecorder()
    const { source } = tokenSource([{ token: 'tok-1', expiresAt: FUTURE }])
    const store = toWebdav({
      baseUrl: 'https://dav.example.com',
      fetch,
      headers: { Authorization: 'Basic c3RhdGlj', 'X-Custom': 'kept' },
      credentials: source,
    })

    await store.get('v', 'c', 'a')

    expect(calls[0]!.headers['Authorization']).toBe('Bearer tok-1')
    expect(calls[0]!.headers['X-Custom']).toBe('kept')
  })

  it('leaves headers untouched when credentials is not supplied', async () => {
    const { fetch, calls } = fetchRecorder()
    const store = toWebdav({
      baseUrl: 'https://dav.example.com',
      fetch,
      headers: { Authorization: 'Basic c3RhdGlj' },
    })

    await store.get('v', 'c', 'a')

    expect(calls[0]!.headers['Authorization']).toBe('Basic c3RhdGlj')
  })
})
