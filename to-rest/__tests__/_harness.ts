import type { NoydbStore, EncryptedEnvelope, VaultSnapshot } from '@noy-db/hub/to'
import { ConflictError } from '@noy-db/hub/to'
import { createRestHandler } from '@noy-db/in-rest'
import type { RestRequest } from '@noy-db/in-rest'

/**
 * Test harness for `to-rest` (#55): a minimal in-memory `NoydbStore`
 * fixture served by a LIVE `createRestHandler` from the published
 * `@noy-db/in-rest`, exposed through a `fetch`-shaped adapter — so the
 * client's conformance run exercises the real wire contract (router,
 * auth, error envelopes), not a mock of it.
 *
 * Auth: the handler authorizes exactly `Authorization: Bearer test-key`,
 * matching in-rest's fail-closed model.
 *
 * `requests` records every dispatched request with its headers EXACTLY as
 * the client wrote them (no key normalization) — the handler needs
 * lowercased keys, but tests asserting header assembly must see the raw
 * wire form, otherwise a duplicate `Authorization`/`authorization` pair
 * collapses before the assertion can catch it.
 */
export interface CapturedRequest {
  readonly url: string
  readonly method: string
  readonly headers: Record<string, string>
  readonly body: string | undefined
}

export function restHarness(): { fetch: typeof fetch; backing: NoydbStore; requests: CapturedRequest[] } {
  // vault -> collection -> id -> envelope
  const data = new Map<string, Map<string, Map<string, EncryptedEnvelope>>>()

  const coll = (vault: string, collection: string) => {
    let v = data.get(vault)
    if (!v) data.set(vault, (v = new Map()))
    let c = v.get(collection)
    if (!c) v.set(collection, (c = new Map()))
    return c
  }

  const backing: NoydbStore = {
    name: 'rest-harness-memory',
    capabilities: { casAtomic: true, auth: { kind: 'none', required: false, flow: 'static' } },

    async get(vault, collection, id) {
      return data.get(vault)?.get(collection)?.get(id) ?? null
    },

    async put(vault, collection, id, envelope, expectedVersion) {
      const existing = data.get(vault)?.get(collection)?.get(id)
      if (expectedVersion !== undefined && existing && existing._v !== expectedVersion) {
        throw new ConflictError(existing._v, `Version conflict: expected ${expectedVersion}, found ${existing._v}`)
      }
      coll(vault, collection).set(id, envelope)
    },

    async delete(vault, collection, id) {
      data.get(vault)?.get(collection)?.delete(id)
    },

    async list(vault, collection) {
      return [...(data.get(vault)?.get(collection)?.keys() ?? [])].sort()
    },

    async loadAll(vault) {
      const snap: VaultSnapshot = {}
      for (const [collection, records] of data.get(vault) ?? []) {
        if (collection.startsWith('_')) continue
        const bucket: Record<string, EncryptedEnvelope> = {}
        for (const [id, envelope] of records) bucket[id] = envelope
        snap[collection] = bucket
      }
      return snap
    },

    async saveAll(vault, snapshot) {
      data.set(vault, new Map())
      for (const [collection, records] of Object.entries(snapshot)) {
        for (const [id, envelope] of Object.entries(records)) {
          coll(vault, collection).set(id, envelope)
        }
      }
    },

    async ping() {
      return true
    },

    async listVaults() {
      return [...data.keys()]
    },

    async listPage(vault, collection, cursor, limit = 100) {
      const ids = [...(data.get(vault)?.get(collection)?.keys() ?? [])].sort()
      const after = cursor ?? ''
      const remaining = ids.filter(id => id > after)
      const page = remaining.slice(0, limit)
      return {
        items: page.map(id => ({ id, envelope: data.get(vault)!.get(collection)!.get(id)! })),
        nextCursor: remaining.length > limit ? page[page.length - 1]! : null,
      }
    },
  }

  const handler = createRestHandler({
    store: backing,
    authorize: req => req.headers['authorization'] === 'Bearer test-key',
  })

  const requests: CapturedRequest[] = []

  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url)
    const rawHeaders = { ...((init?.headers ?? {}) as Record<string, string>) }
    requests.push({
      url: url.href,
      method: init?.method ?? 'GET',
      headers: rawHeaders,
      body: init?.body === undefined ? undefined : String(init.body),
    })
    const headers: Record<string, string> = {}
    for (const [k, v] of Object.entries(rawHeaders)) {
      headers[k.toLowerCase()] = v
    }
    const req: RestRequest = {
      method: init?.method ?? 'GET',
      pathname: url.pathname,
      searchParams: url.searchParams,
      headers,
      json: async () => JSON.parse(String(init?.body ?? 'null')),
    }
    const res = await handler.handle(req)
    return {
      ok: res.status >= 200 && res.status < 300,
      status: res.status,
      json: async () => JSON.parse(typeof res.body === 'string' ? res.body : 'null'),
    }
  }) as unknown as typeof fetch

  return { fetch: fetchImpl, backing, requests }
}
