/**
 * **@noy-db/to-rest** — NoydbStore client for the `@noy-db/in-rest`
 * ciphertext RPC proxy.
 *
 * The HTTP mirror of `@noy-db/by-peer`'s `peerStore()`: every store
 * method is serialized as `POST {baseUrl}/rpc` with `{ method, args }`,
 * where `args` is the store method's positional tuple, exactly as the
 * `NoydbStore` signature. The server (an `@noy-db/in-rest`
 * `createRestHandler`) funnels the RPC into its own backing store —
 * it forwards ciphertext envelopes verbatim and never sees a
 * secret or plaintext (noy-db#963 finding-2 architecture).
 *
 * ```ts
 * import { toRest } from '@noy-db/to-rest'
 *
 * const store = toRest({
 *   baseUrl: 'https://vault.example.com/api',
 *   headers: { authorization: `Bearer ${API_KEY}` },
 * })
 * const db = await createNoydb({ store })
 * ```
 *
 * For a rolling short-lived token, pass `credentials` (the hub's
 * credential-broker seam) instead of a static header — it is re-read on
 * every request and wins over any `authorization` header:
 *
 * ```ts
 * const store = toRest({
 *   baseUrl: 'https://vault.example.com/api',
 *   credentials: async () => ({ kind: 'token', token: await mintToken() }),
 * })
 * ```
 *
 * ## Wire contract (server: `@noy-db/in-rest` >= 0.6.0-pre.0)
 *
 * | Server response | Client behavior |
 * |---|---|
 * | `200` | JSON result, returned as-is |
 * | `409 { error: { name: 'ConflictError', version? } }` | re-thrown as `ConflictError` — CAS semantics survive the wire hop. Keyed on `name` alone; `version` is OPTIONAL and becomes `NaN` when the server omits it |
 * | `401` | auth error (the server's `authorize` is fail-closed — send the header it expects) |
 * | `403` | capability error (method not in the server's `allow` set) |
 * | `501` | the server's backing store lacks this optional method |
 * | other  | server/store error carrying the error NAME only (the server never echoes internals) |
 *
 * ## Capabilities
 *
 * | Capability  | Value |
 * |-------------|-------|
 * | `casAtomic` | `true` — `expectedVersion` rides the wire; the server's backing store enforces it and the 409 envelope re-hydrates `ConflictError` |
 * | `listPage` / `listVaults` / `listSince` | pass-throughs — the server answers `501` when its backing store lacks them |
 * | `ping`      | ✓ — RPC `ping`; returns `false` on any transport failure |
 *
 * @packageDocumentation
 */

import type {
  NoydbStore,
  EncryptedEnvelope,
  VaultSnapshot,
  ListPageResult,
  StoreCredentialSource,
  StoreDescriptor,
  StoreFactory,
  StoreLocator,
} from '@noy-db/hub/to'
import { ConflictError } from '@noy-db/hub/to'

export interface RestStoreOptions {
  /** Base URL the in-rest handler is mounted at (with or without trailing slash); `/rpc` is appended. */
  readonly baseUrl: string
  /**
   * Headers sent with every request — supply whatever the server's
   * fail-closed `authorize` expects (typically `{ authorization: 'Bearer …' }`).
   */
  readonly headers?: Record<string, string>
  /**
   * Rolling short-lived credentials source (the hub's #479 credential-broker
   * seam). Must yield `kind: 'token'`; the token becomes
   * `Authorization: Bearer <token>` and the source is re-invoked on every
   * request, so an expiring token refreshes without rebuilding the store.
   * Takes precedence over any `authorization` key in `headers` —
   * case-insensitively, so an `Authorization` spelling is overridden too.
   *
   * Note the divergence from the other broker consumers: `to-webdav` and
   * `to-turso` cache the token and re-invoke only inside a refresh-skew
   * window of `expiresAt`, and the AWS stores hand the source to the SDK,
   * which memoizes it. `to-rest` does neither — it invokes the source
   * once per store operation and never consults `expiresAt`. The cost is
   * real: a broker backed by a remote token endpoint incurs one extra
   * round-trip per store operation. Wrap such a source in your own cache
   * if that matters; the store deliberately holds no token state.
   */
  readonly credentials?: StoreCredentialSource
  /** Max ms to wait for any single RPC response. Default 30s. */
  readonly timeoutMs?: number
  /** Custom fetch — defaults to `globalThis.fetch`. */
  readonly fetch?: typeof fetch
}

interface WireError {
  readonly name?: string
  readonly message?: string
  readonly version?: number
}

/**
 * Create a `NoydbStore` that forwards every operation to a remote
 * `@noy-db/in-rest` RPC proxy. `dispose()` is a no-op today (reserved
 * for connection teardown, mirroring `by-peer`'s `peerStore()` shape).
 */
export function toRest(options: RestStoreOptions): NoydbStore & { dispose: () => void } {
  const { headers = {}, timeoutMs = 30_000 } = options
  const fetchImpl = options.fetch ?? globalThis.fetch
  const rpcUrl = `${options.baseUrl.replace(/\/+$/, '')}/rpc`

  // HTTP header names are case-insensitive, but object spread only
  // overrides an IDENTICAL key: a caller-supplied `Authorization` would
  // survive alongside the broker's `authorization`, and fetch's `Headers`
  // then APPENDS rather than replaces ("Bearer A, Bearer B"). Lowercasing
  // every key once before merging makes precedence genuinely
  // case-insensitive (same for `Content-Type`).
  const lower = (h: Record<string, string>): Record<string, string> =>
    Object.fromEntries(Object.entries(h).map(([k, v]) => [k.toLowerCase(), v]))

  const staticHeaders = lower(headers)

  async function authHeader(): Promise<Record<string, string>> {
    if (!options.credentials) return {}
    const creds = await options.credentials()
    if (creds.kind !== 'token') {
      throw new Error(
        `to-rest: credentials of kind '${creds.kind}' are not supported — to-rest authenticates with a bearer token (kind: 'token').`,
      )
    }
    return { authorization: `Bearer ${creds.token}` }
  }

  async function call<T>(method: string, args: readonly unknown[]): Promise<T> {
    // JSON has no `undefined`: a trailing optional arg (expectedVersion,
    // cursor, limit) would serialize as `null` and the server would treat
    // it as a real value (e.g. `expectedVersion: null` ≠ omitted). Trim
    // trailing undefineds so optional-arg omission survives the wire.
    const tuple = [...args]
    while (tuple.length > 0 && tuple[tuple.length - 1] === undefined) tuple.pop()
    const res = await fetchImpl(rpcUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...staticHeaders, ...(await authHeader()) },
      body: JSON.stringify({ method, args: tuple }),
      signal: AbortSignal.timeout(timeoutMs),
    })
    if (res.status === 200) {
      return (await res.json()) as T
    }
    let wire: WireError = {}
    try {
      wire = ((await res.json()) as { error?: WireError })?.error ?? {}
    } catch {
      // non-JSON error body — fall through to the generic mapping below
    }
    // Re-hydrate ConflictError so CAS semantics survive the wire hop
    // (mirrors by-peer's peer-store re-hydration).
    //
    // Keyed on `name` ALONE — `version` is optional (#114). noy-db #1218
    // removes that field from in-rest's 409 body because it discloses
    // another writer's progress counter; requiring it here would make a
    // post-#1218 conflict fall through to the generic mapping below and
    // arrive as a plain Error. `isConflictError()` would then be false at
    // every store-boundary catch in hub (#935), silently collapsing a
    // retry/merge state into an unknown-server-error one.
    //
    // Absent (or null — JSON has no `undefined`) becomes NaN, never a
    // sentinel: it satisfies the declared `number`, no comparison against
    // it can accidentally succeed, and it cannot masquerade as a real
    // stored version.
    if (wire.name === 'ConflictError') {
      throw new ConflictError(typeof wire.version === 'number' ? wire.version : Number.NaN, wire.message)
    }
    if (res.status === 401) {
      throw new Error(
        `to-rest: unauthorized (401) — the server's authorize hook rejected the request; check the Authorization header (${wire.message ?? 'unauthorized'})`,
      )
    }
    if (res.status === 403) {
      throw new Error(`to-rest: method not allowed by the server (403): ${wire.message ?? method}`)
    }
    if (res.status === 501) {
      throw new Error(`to-rest: method not implemented by the server's backing store (501): ${wire.message ?? method}`)
    }
    throw new Error(`to-rest: server error (${res.status}): ${wire.name ?? 'Error'} — ${wire.message ?? 'store error'}`)
  }

  return {
    name: 'rest',
    capabilities: {
      // CAS is enforced server-side by the backing store: expectedVersion
      // rides the RPC tuple and a 409 envelope re-hydrates ConflictError,
      // so a CAS put has the same semantics as a direct store call.
      casAtomic: true,
      auth: { kind: 'api-key', required: true, flow: 'static' },
    },

    async get(vault, collection, id) {
      return call<EncryptedEnvelope | null>('get', [vault, collection, id])
    },

    async put(vault, collection, id, envelope, expectedVersion) {
      await call<null>('put', [vault, collection, id, envelope, expectedVersion])
    },

    async delete(vault, collection, id) {
      await call<null>('delete', [vault, collection, id])
    },

    async list(vault, collection) {
      return call<string[]>('list', [vault, collection])
    },

    async loadAll(vault) {
      return call<VaultSnapshot>('loadAll', [vault])
    },

    async saveAll(vault, data) {
      await call<null>('saveAll', [vault, data])
    },

    async ping() {
      try {
        return await call<boolean>('ping', [])
      } catch {
        return false
      }
    },

    async listSince(vault, collection, since) {
      return call('listSince', [vault, collection, since])
    },

    async listPage(vault, collection, cursor, limit) {
      return call<ListPageResult>('listPage', [vault, collection, cursor, limit])
    },

    async listVaults() {
      return call<string[]>('listVaults', [])
    },

    dispose() {
      // No persistent connection today — reserved for keep-alive teardown.
    },
  }
}

// ─── Store-locator descriptor (#58 — `cloud` class) ──────────────────

/** Serializable location of a rest store: the in-rest handler's base URL. */
export interface RestAddress {
  readonly baseUrl: string
}

/** Serializable tuning carried on the descriptor (never credentials). */
export interface RestDescriptorOptions {
  readonly timeoutMs?: number
}

/**
 * Device-local supplement resolved at `resolve()` time. Both fields are
 * barred from the descriptor: `fetch` is a function, and `headers` is
 * where an `authorization` value would otherwise leak. Auth belongs on
 * `credentials`; `headers` here is for non-auth headers such as tenant
 * routing or tracing.
 */
export interface RestBinding {
  readonly fetch?: typeof fetch
  readonly headers?: Record<string, string>
}

/**
 * Builds the `StoreDescriptor` form of a `toRest()` store:
 * `kind: 'rest'`, `class: 'cloud'`. Credentialless by construction — the
 * bearer token arrives via a `StoreCredentialSource` of `kind: 'token'`
 * at `resolve()` time and is re-read on every request.
 */
export function restStoreDescriptor(address: RestAddress, options?: RestDescriptorOptions): StoreDescriptor {
  return { kind: 'rest', class: 'cloud', address, ...(options !== undefined && { options }) }
}

/**
 * `StoreFactory` for `to-rest`: reconstructs the same store `toRest()`
 * builds, from a descriptor produced by {@link restStoreDescriptor}.
 * `opts.binding` supplies the transport ({@link RestBinding});
 * `opts.credentials` supplies auth, which wins over any `authorization`
 * key in `binding.headers`.
 */
export const restStoreFactory: StoreFactory = (descriptor, opts) => {
  const { baseUrl } = descriptor.address as RestAddress
  const { timeoutMs } = (descriptor.options ?? {}) as RestDescriptorOptions
  const binding = (opts.binding ?? {}) as RestBinding
  return toRest({
    baseUrl,
    ...(timeoutMs !== undefined && { timeoutMs }),
    ...(binding.headers !== undefined && { headers: binding.headers }),
    ...(binding.fetch !== undefined && { fetch: binding.fetch }),
    ...(opts.credentials !== undefined && { credentials: opts.credentials }),
  })
}

/** Registers {@link restStoreFactory} under the `'rest'` kind on `locator`. */
export function registerRestStore(locator: StoreLocator): void {
  locator.register('rest', restStoreFactory)
}
