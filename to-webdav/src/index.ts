/**
 * **@noy-db/to-webdav** — WebDAV-backed noy-db store.
 *
 * Per-record JSON objects over the WebDAV protocol (RFC 4918). Works
 * against Nextcloud, ownCloud, Apache `mod_dav`, nginx WebDAV, or any
 * compliant server. Pure `fetch()` — zero dependencies.
 *
 * Key path:
 *   `{baseUrl}/{prefix}/{vault}/{collection}/{id}.json`
 *
 * ## Capabilities
 *
 * | Capability  | Value |
 * |-------------|-------|
 * | `casAtomic` | `false` — WebDAV has no atomic CAS; last-write-wins |
 * | `listPage`  | ✗ — `PROPFIND` Depth:1 returns the whole collection |
 * | `ping`      | ✓ — `PROPFIND Depth:0` on the root |
 *
 * For conflict-safe writes pair with `@noy-db/to-aws-dynamo` or
 * `@noy-db/to-postgres` as the primary and use WebDAV as a
 * `backup`/`archive` target in `routeStore`.
 *
 * ## Authentication
 *
 * WebDAV commonly uses Basic Auth. Pass an `Authorization` header via
 * `headers`, or override `fetch` with a wrapper that injects your
 * credentials (session token, app password, OAuth token).
 *
 * @packageDocumentation
 */

import type { NoydbStore, EncryptedEnvelope, VaultSnapshot, StoreCredentialSource, StoreDescriptor, StoreFactory, StoreLocator } from '@noy-db/hub/to'
import { ConflictError } from '@noy-db/hub/to'

/** Refresh the cached token this many ms before its `expiresAt`. */
const TOKEN_REFRESH_SKEW_MS = 30_000

export interface WebDAVStoreOptions {
  /** Base URL of the WebDAV endpoint (with trailing slash optional). */
  readonly baseUrl: string
  /** Path prefix within the endpoint. Default `''`. */
  readonly prefix?: string
  /** Default headers sent with every request (e.g. Authorization). */
  readonly headers?: Record<string, string>
  /**
   * Rolling short-lived credentials source (the hub's #479 credential-broker
   * seam). The provider must yield `kind: 'token'` credentials; the token is
   * injected on every request as `Authorization: Bearer <token>`, overriding
   * any static `headers` Authorization. The store caches the token and
   * re-invokes the source shortly before `expiresAt` (no `expiresAt` →
   * cached for the store's lifetime).
   */
  readonly credentials?: StoreCredentialSource
  /** Custom fetch — defaults to `globalThis.fetch`. */
  readonly fetch?: typeof fetch
  /**
   * When `true` (default), PUT errors from missing parent collections
   * are recovered by MKCOL'ing the path and retrying once. Set to
   * `false` if the server already has the tree provisioned.
   */
  readonly autoMkcol?: boolean
  /**
   * When `true`, MKCOL the full path tree before EVERY put — not just
   * as a 404/409 fallback. Default `false`.
   *
   * Required for non-RFC-compliant servers (notably DriveHQ free tier
   * and some embedded NAS firmwares) that return `204 No Content` on a
   * PUT to a non-existent path AND silently flatten the file to the
   * server root instead of preserving the requested path. Without
   * eager MKCOL, the package's lazy fallback never fires (no 4xx to
   * trigger it) and writes silently land at the wrong location.
   *
   * Adds one extra round-trip per put; only enable when you've
   * confirmed your server has this quirk.
   */
  readonly eagerMkcol?: boolean
}

export function toWebdav(options: WebDAVStoreOptions): NoydbStore {
  const {
    baseUrl: rawBase,
    prefix = '',
    headers: baseHeaders = {},
    fetch: fetchImpl = globalThis.fetch.bind(globalThis),
    autoMkcol = true,
    eagerMkcol = false,
  } = options

  const baseUrl = rawBase.endsWith('/') ? rawBase.slice(0, -1) : rawBase

  // #479 refresh hook — token cache. The store owns refresh (fetch has no
  // provider contract like the AWS SDK): re-invoke the source when the
  // cached token is missing or within TOKEN_REFRESH_SKEW_MS of expiry.
  let cachedToken: { token: string; expiresAtMs: number | null } | null = null

  async function requestHeaders(): Promise<Record<string, string>> {
    if (!options.credentials) return baseHeaders
    if (
      !cachedToken ||
      (cachedToken.expiresAtMs !== null && Date.now() >= cachedToken.expiresAtMs - TOKEN_REFRESH_SKEW_MS)
    ) {
      const creds = await options.credentials()
      if (creds.kind !== 'token') {
        throw new Error(`@noy-db/to-webdav: credentials hook returned kind '${creds.kind}', expected 'token'`)
      }
      cachedToken = {
        token: creds.token,
        expiresAtMs: creds.expiresAt ? Date.parse(creds.expiresAt) : null,
      }
    }
    return { ...baseHeaders, Authorization: `Bearer ${cachedToken.token}` }
  }

  function urlFor(vault: string, collection: string, id: string): string {
    const segments = [prefix, vault, collection, `${id}.json`]
      .filter(Boolean)
      .map(encodeURIComponent)
    return `${baseUrl}/${segments.join('/')}`
  }

  function collectionUrl(vault: string, collection: string): string {
    const segments = [prefix, vault, collection].filter(Boolean).map(encodeURIComponent)
    return `${baseUrl}/${segments.join('/')}/`
  }

  async function mkcolRecursive(vault: string, collection?: string): Promise<void> {
    const parts = [prefix, vault, ...(collection ? [collection] : [])].filter(Boolean)
    let url = baseUrl
    for (const part of parts) {
      url += `/${encodeURIComponent(part)}`
      const res = await fetchImpl(url + '/', { method: 'MKCOL', headers: await requestHeaders() })
      // 201 Created, 405 Method Not Allowed (exists), and 409 Conflict are all
      // acceptable — we only fail on transport-level errors.
      if (res.status >= 500) {
        throw new Error(`WebDAV MKCOL failed at ${url}: ${res.status}`)
      }
    }
  }

  async function putOnce(vault: string, collection: string, id: string, body: string): Promise<Response> {
    return fetchImpl(urlFor(vault, collection, id), {
      method: 'PUT',
      headers: {
        ...(await requestHeaders()),
        'Content-Type': 'application/json',
      },
      body,
    })
  }

  // Very small PROPFIND XML body — we only need child hrefs.
  const PROPFIND_BODY = `<?xml version="1.0" encoding="utf-8"?>
<d:propfind xmlns:d="DAV:"><d:prop><d:resourcetype/></d:prop></d:propfind>`

  async function listChildren(vault: string, collection: string): Promise<string[]> {
    const url = collectionUrl(vault, collection)
    const res = await fetchImpl(url, {
      method: 'PROPFIND',
      headers: {
        ...(await requestHeaders()),
        Depth: '1',
        'Content-Type': 'application/xml',
      },
      body: PROPFIND_BODY,
    })
    if (res.status === 404) return []
    if (!res.ok && res.status !== 207) {
      throw new Error(`WebDAV PROPFIND failed: ${res.status}`)
    }
    const xml = await res.text()
    // Extract <d:href>...</d:href> entries, drop the collection self-ref,
    // keep only .json leaves, and return the id portion.
    const hrefs = Array.from(xml.matchAll(/<(?:\w+:)?href>([^<]+)<\/(?:\w+:)?href>/g))
      .map(m => decodeURIComponent(m[1]!))
    const selfPath = new URL(url).pathname.replace(/\/+$/, '')
    const ids: string[] = []
    for (const href of hrefs) {
      const hrefPath = href.replace(/\/+$/, '')
      if (hrefPath === selfPath) continue
      const filename = hrefPath.split('/').pop()!
      if (!filename.endsWith('.json')) continue
      ids.push(filename.slice(0, -'.json'.length))
    }
    return ids.sort()
  }

  const store: NoydbStore = {
    name: 'webdav',
    capabilities: {
      casAtomic: false,
      auth: { kind: 'api-key', required: false, flow: 'static' },
    },

    async get(vault, collection, id) {
      const res = await fetchImpl(urlFor(vault, collection, id), {
        method: 'GET',
        headers: await requestHeaders(),
      })
      if (res.status === 404) return null
      if (!res.ok) throw new Error(`WebDAV GET failed: ${res.status}`)
      const text = await res.text()
      return JSON.parse(text) as EncryptedEnvelope
    },

    async put(vault, collection, id, envelope, expectedVersion) {
      // casAtomic: false — WebDAV lacks server-side conditional metadata
      // writes, so the check below is best-effort read-then-write (not
      // atomic under a concurrent writer). The contract still requires an
      // OBSERVED version mismatch to throw — reference behaviour:
      // @noy-db/to-file (found by the conformance suite, #26).
      if (expectedVersion !== undefined) {
        const current = await store.get(vault, collection, id)
        if (current !== null && current._v !== expectedVersion) {
          throw new ConflictError(current._v, `Version conflict: expected ${expectedVersion}, found ${current._v}`)
        }
      }
      const body = JSON.stringify(envelope)
      // Eager MKCOL: required for non-RFC servers (DriveHQ etc.) that
      // accept PUT-to-nonexistent with 204 and silently flatten.
      if (eagerMkcol) {
        await mkcolRecursive(vault, collection)
      }
      let res = await putOnce(vault, collection, id, body)
      if ((res.status === 404 || res.status === 409) && autoMkcol) {
        await mkcolRecursive(vault, collection)
        res = await putOnce(vault, collection, id, body)
      }
      if (!res.ok) throw new Error(`WebDAV PUT failed: ${res.status}`)
    },

    async delete(vault, collection, id) {
      const res = await fetchImpl(urlFor(vault, collection, id), {
        method: 'DELETE',
        headers: await requestHeaders(),
      })
      if (res.status !== 204 && res.status !== 404 && !res.ok) {
        throw new Error(`WebDAV DELETE failed: ${res.status}`)
      }
    },

    async list(vault, collection) {
      return listChildren(vault, collection)
    },

    async loadAll(vault) {
      const rootUrl = `${baseUrl}/${[prefix, vault].filter(Boolean).map(encodeURIComponent).join('/')}/`
      const res = await fetchImpl(rootUrl, {
        method: 'PROPFIND',
        headers: { ...(await requestHeaders()), Depth: '1', 'Content-Type': 'application/xml' },
        body: PROPFIND_BODY,
      })
      if (res.status === 404) return {}
      if (!res.ok && res.status !== 207) {
        throw new Error(`WebDAV PROPFIND (loadAll) failed: ${res.status}`)
      }
      const xml = await res.text()
      const hrefs = Array.from(xml.matchAll(/<(?:\w+:)?href>([^<]+)<\/(?:\w+:)?href>/g))
        .map(m => decodeURIComponent(m[1]!))
      const selfPath = new URL(rootUrl).pathname.replace(/\/+$/, '')
      const collections = new Set<string>()
      for (const href of hrefs) {
        const hrefPath = href.replace(/\/+$/, '')
        if (hrefPath === selfPath) continue
        const segment = hrefPath.slice(selfPath.length + 1).split('/')[0]
        if (!segment) continue
        const collection = decodeURIComponent(segment)
        // Internal collections (`_keyring`, `_sync`) are the vault's own
        // bookkeeping and must not appear in a snapshot — store contract,
        // reference behaviour: @noy-db/to-file (#26).
        if (collection.startsWith('_')) continue
        collections.add(collection)
      }
      const snap: VaultSnapshot = {}
      for (const collection of collections) {
        const ids = await listChildren(vault, collection)
        const bucket: Record<string, EncryptedEnvelope> = {}
        for (const id of ids) {
          const env = await store.get(vault, collection, id)
          if (env) bucket[id] = env
        }
        snap[collection] = bucket
      }
      return snap
    },

    async saveAll(vault, data) {
      for (const [collection, recs] of Object.entries(data)) {
        await mkcolRecursive(vault, collection)
        for (const [id, envelope] of Object.entries(recs)) {
          await store.put(vault, collection, id, envelope)
        }
      }
    },

    async ping() {
      try {
        const res = await fetchImpl(baseUrl + '/', {
          method: 'PROPFIND',
          headers: { ...(await requestHeaders()), Depth: '0' },
        })
        return res.ok || res.status === 207
      } catch {
        return false
      }
    },
  }

  return store
}

// ─── Store-locator descriptor (#56 / noy-db#945 — `lan`-class model citizen) ──

/** Serializable location of a WebDAV store: the endpoint + path prefix. */
export interface WebdavAddress {
  readonly baseUrl: string
  readonly prefix?: string
}

/** Serializable tuning carried on the descriptor (never credentials). */
export interface WebdavDescriptorOptions {
  readonly autoMkcol?: boolean
  readonly eagerMkcol?: boolean
}

/**
 * Device-local supplement resolved at `resolve()` time — a transport
 * override (custom fetch wrapper injecting session auth, or a test fake)
 * and/or static headers. Never serialized into a pod alongside the
 * descriptor.
 */
export interface WebdavBinding {
  readonly fetch?: typeof fetch
  readonly headers?: Record<string, string>
}

/**
 * Builds the `StoreDescriptor` form of a `toWebdav()` store:
 * `kind: 'webdav'`, `class: 'lan'`, with the endpoint address and the
 * serializable server-quirk flags as `options`. Credentialless by
 * construction — auth arrives via `StoreCredentialSource` at
 * `resolve()` time, or via a `binding` fetch/headers override.
 */
export function webdavStoreDescriptor(address: WebdavAddress, options?: WebdavDescriptorOptions): StoreDescriptor {
  return { kind: 'webdav', class: 'lan', address, ...(options !== undefined && { options }) }
}

/**
 * `StoreFactory` for `to-webdav`: reconstructs the same store
 * `toWebdav()` builds, from a descriptor produced by
 * {@link webdavStoreDescriptor}. `opts.credentials` becomes the store's
 * rolling-token source; `opts.binding` may carry a device-local
 * transport override ({@link WebdavBinding}).
 */
export const webdavStoreFactory: StoreFactory = (descriptor, opts) => {
  const { baseUrl, prefix } = descriptor.address as WebdavAddress
  const { autoMkcol, eagerMkcol } = (descriptor.options ?? {}) as WebdavDescriptorOptions
  const binding = (opts.binding ?? {}) as WebdavBinding
  return toWebdav({
    baseUrl,
    ...(prefix !== undefined && { prefix }),
    ...(autoMkcol !== undefined && { autoMkcol }),
    ...(eagerMkcol !== undefined && { eagerMkcol }),
    ...(opts.credentials !== undefined && { credentials: opts.credentials }),
    ...(binding.fetch !== undefined && { fetch: binding.fetch }),
    ...(binding.headers !== undefined && { headers: binding.headers }),
  })
}

/** Registers {@link webdavStoreFactory} under the `'webdav'` kind on `locator`. */
export function registerWebdavStore(locator: StoreLocator): void {
  locator.register('webdav', webdavStoreFactory)
}
