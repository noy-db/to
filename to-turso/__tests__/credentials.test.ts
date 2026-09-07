import { describe, it, expect } from 'vitest'
import type { StoreCredentials } from '@noy-db/hub/to'
import { toTurso, type LibsqlClient } from '../src/index.js'

// #479 credential-broker adoption for Turso (noy-db-to#11) — libSQL clients
// take a static `authToken` at construction, so the STORE owns the refresh:
// pass `clientFactory` (typically `authToken => createClient({ url, authToken })`)
// plus `credentials`; the store rebuilds the client via the factory whenever
// the broker token is missing or near/past `expiresAt`. A pre-built `client`
// always wins (factory + credentials are then ignored).

function stubClient(label: string): LibsqlClient & { executed: string[] } {
  const executed: string[] = []
  return {
    executed,
    async execute(args: string | { sql: string; args?: readonly unknown[] }) {
      executed.push(typeof args === 'string' ? args : args.sql)
      return { rows: [] }
    },
  }
}

function factoryRecorder(): {
  factory: (authToken: string) => LibsqlClient
  tokens: string[]
  clients: Array<LibsqlClient & { executed: string[] }>
} {
  const tokens: string[] = []
  const clients: Array<LibsqlClient & { executed: string[] }> = []
  return {
    tokens,
    clients,
    factory: (authToken: string) => {
      tokens.push(authToken)
      const c = stubClient(`client-${tokens.length}`)
      clients.push(c)
      return c
    },
  }
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

describe('to-turso — credentials refresh hook', () => {
  it('builds the client via clientFactory with the broker token and executes through it', async () => {
    const { factory, tokens, clients } = factoryRecorder()
    const { source } = tokenSource([{ token: 'tok-1', expiresAt: FUTURE }])
    const store = toTurso({ clientFactory: factory, credentials: source })

    await store.get('v', 'c', 'id1')

    expect(tokens).toEqual(['tok-1'])
    expect(clients[0]!.executed.length).toBeGreaterThan(0)
  })

  it('reuses the same client across operations while the token is unexpired', async () => {
    const { factory, tokens } = factoryRecorder()
    const { source, invocations } = tokenSource([{ token: 'tok-1', expiresAt: FUTURE }])
    const store = toTurso({ clientFactory: factory, credentials: source })

    await store.get('v', 'c', 'a')
    await store.get('v', 'c', 'b')

    expect(tokens).toEqual(['tok-1'])
    expect(invocations()).toBe(1)
  })

  it('rebuilds the client with the fresh token once expiresAt has passed', async () => {
    const { factory, tokens, clients } = factoryRecorder()
    const { source } = tokenSource([
      { token: 'tok-old', expiresAt: PAST },
      { token: 'tok-new', expiresAt: FUTURE },
    ])
    const store = toTurso({ clientFactory: factory, credentials: source })

    await store.get('v', 'c', 'a') // built with tok-old (already expired at issue time)
    const opsOnFirst = clients[0]!.executed.length
    await store.get('v', 'c', 'b') // must rebuild → tok-new

    expect(tokens).toEqual(['tok-old', 'tok-new'])
    expect(clients[0]!.executed.length).toBe(opsOnFirst) // first client no longer used
    expect(clients[1]!.executed.length).toBeGreaterThan(0)
  })

  it('rejects a non-token credential kind with a clear message', async () => {
    const { factory } = factoryRecorder()
    const store = toTurso({
      clientFactory: factory,
      credentials: async () => ({ kind: 'aws', accessKeyId: 'a', secretAccessKey: 's' }),
    })

    await expect(store.get('v', 'c', 'a')).rejects.toThrow(/kind 'aws'.*expected 'token'/)
  })

  it('a pre-built client wins — factory and credentials are never invoked', async () => {
    const { factory, tokens } = factoryRecorder()
    const { source, invocations } = tokenSource([{ token: 'tok-1', expiresAt: FUTURE }])
    const direct = stubClient('direct')
    const store = toTurso({ client: direct, clientFactory: factory, credentials: source })

    await store.get('v', 'c', 'a')

    expect(direct.executed.length).toBeGreaterThan(0)
    expect(tokens).toEqual([])
    expect(invocations()).toBe(0)
  })

  it('throws at construction when neither client nor clientFactory+credentials is supplied', () => {
    expect(() => toTurso({})).toThrow(/client.*clientFactory.*credentials/i)
    const { factory } = factoryRecorder()
    expect(() => toTurso({ clientFactory: factory })).toThrow(/client.*clientFactory.*credentials/i)
  })
})
