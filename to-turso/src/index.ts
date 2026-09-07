/**
 * **@noy-db/to-turso** — Turso / libSQL adapter for noy-db.
 *
 * Turso is hosted libSQL — a fork of SQLite with built-in multi-region
 * replication, edge-friendly HTTP/WebSocket transport, and a native
 * `@libsql/client` driver whose API returns Promises (unlike
 * `better-sqlite3`'s synchronous methods).
 *
 * This package implements the 6-method `NoydbStore` contract directly
 * against a duck-typed `LibsqlClient`, not via a shim on top of
 * `@noy-db/to-sqlite`. Rationale: the sync vs async divide in the SQL
 * surface means a shim would either re-introduce a fake synchronous
 * layer (returning a Promise stored as a resolved value is awkward) or
 * duplicate the statement dispatch. A native async implementation is
 * cleaner.
 *
 * The internals match `@noy-db/to-sqlite` closely — same table, same
 * indexes, same DDL, same upsert pattern. Consumers moving from a
 * local SQLite file to hosted Turso can swap the factory call without
 * touching any other part of the config.
 *
 * @packageDocumentation
 */

import type {
  NoydbStore,
  EncryptedEnvelope,
  VaultSnapshot,
  TxOp,
  ListPageResult,
  StoreCredentialSource,
  StoreDescriptor,
  StoreFactory,
  StoreLocator,
} from '@noy-db/hub/to'
import { ConflictError } from '@noy-db/hub/to'

/** Rebuild the client this many ms before the broker token's `expiresAt`. */
const TOKEN_REFRESH_SKEW_MS = 30_000

/**
 * Duck-typed subset of `@libsql/client` — matches the common async
 * shape so `createClient({ url, authToken })` slots in directly.
 */
export interface LibsqlClient {
  execute(args: string | { sql: string; args?: readonly unknown[] }): Promise<LibsqlResultSet>
  batch?(statements: readonly { sql: string; args?: readonly unknown[] }[]): Promise<LibsqlResultSet[]>
}

export interface LibsqlResultSet {
  readonly rows: readonly Record<string, unknown>[]
}

export interface TursoStoreOptions {
  /**
   * Pre-built libSQL client. Always wins: when supplied, `clientFactory`
   * and `credentials` are ignored.
   */
  readonly client?: LibsqlClient
  /**
   * Client builder for the rolling-credentials path — typically
   * `authToken => createClient({ url, authToken })`. Required together
   * with `credentials` when no `client` is supplied.
   */
  readonly clientFactory?: (authToken: string) => LibsqlClient
  /**
   * Rolling short-lived credentials source (the hub's #479 credential-broker
   * seam). The provider must yield `kind: 'token'` credentials. libSQL
   * clients take a static `authToken` at construction, so the store owns the
   * refresh: it rebuilds the client via `clientFactory` whenever the token
   * is missing or near/past `expiresAt` (no `expiresAt` → the first client
   * is kept for the store's lifetime).
   */
  readonly credentials?: StoreCredentialSource
  readonly tableName?: string
  readonly autoMigrate?: boolean
  /** Clock uncertainty bound for serverWriteTime (ms). Default: 1000. */
  readonly clockUncertaintyMs?: number
}

export function toTurso(options: TursoStoreOptions): NoydbStore {
  const { client: staticClient, tableName = 'noydb_envelopes', autoMigrate = true } = options
  const clockUncertaintyMs = options.clockUncertaintyMs ?? 1_000
  let schemaReady: Promise<void> | null = null

  if (!staticClient && !(options.clientFactory && options.credentials)) {
    throw new Error('@noy-db/to-turso: provide either `client`, or `clientFactory` together with `credentials`.')
  }

  // #479 refresh hook — cached factory-built client. Rebuilt (with a fresh
  // broker token) when the token is missing or within the skew of expiry.
  let cached: { client: LibsqlClient; expiresAtMs: number | null } | null = null

  async function getClient(): Promise<LibsqlClient> {
    if (staticClient) return staticClient
    if (
      !cached ||
      (cached.expiresAtMs !== null && Date.now() >= cached.expiresAtMs - TOKEN_REFRESH_SKEW_MS)
    ) {
      const creds = await options.credentials!()
      if (creds.kind !== 'token') {
        throw new Error(`@noy-db/to-turso: credentials hook returned kind '${creds.kind}', expected 'token'`)
      }
      cached = {
        client: options.clientFactory!(creds.token),
        expiresAtMs: creds.expiresAt ? Date.parse(creds.expiresAt) : null,
      }
    }
    return cached.client
  }

  async function ensureSchema(): Promise<void> {
    if (!autoMigrate) return
    if (!schemaReady) {
      schemaReady = (async () => {
        const client = await getClient()
        // New writes only populate vault/collection/id/v/ts/env — `env` is
        // `JSON.stringify(envelope)`, the ENTIRE envelope, so no field (including
        // ones this store doesn't know about, e.g. `_cek`/`_debug`) is ever
        // silently dropped. `v`/`ts` stay as real columns because CAS (`WHERE
        // v = ?`) and ordering need to query them without deserializing `env`.
        // iv/data are still written on every upsert (see the 5 write sites
        // below) so the NOT NULL constraint keeps holding on tables created
        // before this migration; by/tier/elevated_by/det/del are LEGACY
        // columns, kept nullable for dual-read of rows written before this
        // migration (see `rowToEnvelope`) — no data migration script
        // required (pre-1.0).
        await client.execute(
          `CREATE TABLE IF NOT EXISTS ${tableName} (
             vault TEXT NOT NULL,
             collection TEXT NOT NULL,
             id TEXT NOT NULL,
             v INTEGER NOT NULL,
             ts TEXT NOT NULL,
             env TEXT,
             iv TEXT NOT NULL,
             data TEXT NOT NULL,
             by TEXT,
             tier INTEGER,
             elevated_by TEXT,
             det TEXT,
             del INTEGER,
             PRIMARY KEY (vault, collection, id)
           )`,
        )
        // `CREATE TABLE IF NOT EXISTS` is a no-op against a table that
        // already exists from before this migration — it has no `env`
        // column, so every write/read would fail otherwise. `ALTER TABLE
        // ADD COLUMN` backfills it; on a table just created fresh above
        // (env already in the DDL) this throws "duplicate column name",
        // swallowed as the expected no-op. Anything else rethrows.
        try {
          await client.execute(`ALTER TABLE ${tableName} ADD COLUMN env TEXT`)
        } catch (err) {
          if (!(err instanceof Error) || !err.message.toLowerCase().includes('duplicate column name')) throw err
        }
        await client.execute(
          `CREATE INDEX IF NOT EXISTS idx_${tableName}_vc
             ON ${tableName} (vault, collection)`,
        )
      })()
    }
    await schemaReady
  }

  function rowToEnvelope(row: Record<string, unknown>): EncryptedEnvelope {
    const envRaw = row.env as string | null
    if (envRaw != null) {
      return JSON.parse(envRaw) as EncryptedEnvelope
    }
    // Legacy dual-read fallback: row written before the `env` migration —
    // reconstruct from the old per-column layout.
    const by = row.by as string | null
    const tier = row.tier as number | null
    const elevatedBy = row.elevated_by as string | null
    const detRaw = row.det as string | null
    return {
      _noydb: 1,
      _v: row.v as number,
      _ts: row.ts as string,
      _iv: row.iv as string,
      _data: row.data as string,
      ...(by !== null && { _by: by }),
      ...(tier !== null && { _tier: tier }),
      ...(elevatedBy !== null && { _elevatedBy: elevatedBy }),
      ...(detRaw !== null && { _det: JSON.parse(detRaw) as Record<string, string> }),
      ...(row.del === 1 && { _del: true as const }),
    }
  }

  async function upsert(
    vault: string,
    collection: string,
    id: string,
    envelope: EncryptedEnvelope,
    expectedVersion?: number,
  ): Promise<void> {
    await ensureSchema()
    const client = await getClient()

    const envelopeArgs = [
      vault, collection, id, envelope._v, envelope._ts, JSON.stringify(envelope), envelope._iv, envelope._data,
    ] as const

    if (expectedVersion !== undefined) {
      if (expectedVersion === 0) {
        // Create-only: INSERT OR IGNORE — atomic at SQLite's serialized write layer.
        // RETURNING is empty if the row already existed → ConflictError.
        const result = await client.execute({
          sql: `INSERT OR IGNORE INTO ${tableName}
                  (vault, collection, id, v, ts, env, iv, data)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`,
          args: envelopeArgs,
        })
        if (result.rows.length === 0) {
          const check = await client.execute({
            sql: `SELECT v FROM ${tableName} WHERE vault = ? AND collection = ? AND id = ?`,
            args: [vault, collection, id],
          })
          const currentV = (check.rows[0] as { v: number } | undefined)?.v ?? 0
          throw new ConflictError(currentV, 'Concurrent create: record already exists')
        }
        return
      }
      // Update-only: single atomic UPDATE WHERE v=? — second concurrent writer
      // sees 0 RETURNING rows after the first writer commits.
      const result = await client.execute({
        sql: `UPDATE ${tableName}
              SET v = ?, ts = ?, env = ?, iv = ?, data = ?
              WHERE vault = ? AND collection = ? AND id = ? AND v = ?
              RETURNING id`,
        args: [
          envelope._v, envelope._ts, JSON.stringify(envelope), envelope._iv, envelope._data,
          vault, collection, id, expectedVersion,
        ],
      })
      if (result.rows.length === 0) {
        const check = await client.execute({
          sql: `SELECT v FROM ${tableName} WHERE vault = ? AND collection = ? AND id = ?`,
          args: [vault, collection, id],
        })
        const currentV = (check.rows[0] as { v: number } | undefined)?.v ?? 0
        throw new ConflictError(currentV, `Version conflict: expected ${expectedVersion}`)
      }
      return
    }

    // Unconditional upsert — no version guard.
    await client.execute({
      sql:
        `INSERT INTO ${tableName} (vault, collection, id, v, ts, env, iv, data)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(vault, collection, id) DO UPDATE SET
           v = excluded.v, ts = excluded.ts, env = excluded.env, iv = excluded.iv, data = excluded.data`,
      args: envelopeArgs,
    })
  }

  const store: NoydbStore = {
    name: 'turso',
    capabilities: {
      casAtomic: true,
      // libSQL `batch()` runs its statements in one implicit transaction
      // (all-or-nothing), so the atomic-batch capability is honest exactly
      // when the client exposes `batch`. Factory-built clients are real
      // `@libsql/client` instances, which always do; an injected duck-typed
      // client without `batch` falls back to sequential (non-atomic) tx and
      // must not advertise the bit (#22). The batch path enforces per-op
      // `expectedVersion` via in-batch guard statements (#37).
      txAtomic: staticClient ? typeof staticClient.batch === 'function' : true,
      serverWriteTime: true,
      auth: { kind: 'api-key', required: true, flow: 'static' },
    },

    async getStoreTime() {
      const client = await getClient()
      const result = await client.execute("SELECT unixepoch('now','subsec') AS t")
      const seconds = parseFloat(result.rows[0]!.t as string)
      const ms = Math.round(seconds * 1_000)
      return { earliest: ms - clockUncertaintyMs, latest: ms + clockUncertaintyMs }
    },

    async get(vault, collection, id) {
      await ensureSchema()
      const client = await getClient()
      const result = await client.execute({
        sql: `SELECT * FROM ${tableName} WHERE vault = ? AND collection = ? AND id = ?`,
        args: [vault, collection, id],
      })
      const row = result.rows[0]
      return row ? rowToEnvelope(row) : null
    },

    async put(vault, collection, id, envelope, expectedVersion) {
      await upsert(vault, collection, id, envelope, expectedVersion)
    },

    async delete(vault, collection, id) {
      await ensureSchema()
      const client = await getClient()
      await client.execute({
        sql: `DELETE FROM ${tableName} WHERE vault = ? AND collection = ? AND id = ?`,
        args: [vault, collection, id],
      })
    },

    async list(vault, collection) {
      await ensureSchema()
      const client = await getClient()
      const result = await client.execute({
        sql: `SELECT id FROM ${tableName} WHERE vault = ? AND collection = ? ORDER BY id`,
        args: [vault, collection],
      })
      return result.rows.map(r => r.id as string)
    },

    async loadAll(vault) {
      await ensureSchema()
      const client = await getClient()
      const result = await client.execute({
        sql: `SELECT * FROM ${tableName} WHERE vault = ?`,
        args: [vault],
      })
      const snap: VaultSnapshot = {}
      for (const row of result.rows) {
        const collection = row.collection as string
        // Internal collections (`_keyring`, `_sync`) are the vault's own
        // bookkeeping and must not appear in a snapshot — required by the store
        // contract, with `@noy-db/to-file` setting the reference behaviour via
        // the same `_`-prefix rule.
        if (collection.startsWith('_')) continue
        const id = row.id as string
        const bucket = snap[collection] ?? (snap[collection] = {})
        bucket[id] = rowToEnvelope(row)
      }
      return snap
    },

    async saveAll(vault, data) {
      await ensureSchema()
      const client = await getClient()
      if (client.batch) {
        const statements: { sql: string; args?: readonly unknown[] }[] = [
          { sql: `DELETE FROM ${tableName} WHERE vault = ?`, args: [vault] },
        ]
        for (const [collection, recs] of Object.entries(data)) {
          for (const [id, envelope] of Object.entries(recs)) {
            statements.push({
              sql:
                `INSERT INTO ${tableName} (vault, collection, id, v, ts, env, iv, data)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                 ON CONFLICT(vault, collection, id) DO UPDATE SET
                   v = excluded.v, ts = excluded.ts, env = excluded.env, iv = excluded.iv, data = excluded.data`,
              args: [vault, collection, id, envelope._v, envelope._ts, JSON.stringify(envelope), envelope._iv, envelope._data],
            })
          }
        }
        await client.batch(statements)
        return
      }
      // Fallback: sequential execute when the client lacks batch.
      await client.execute({ sql: `DELETE FROM ${tableName} WHERE vault = ?`, args: [vault] })
      for (const [collection, recs] of Object.entries(data)) {
        for (const [id, envelope] of Object.entries(recs)) {
          await upsert(vault, collection, id, envelope)
        }
      }
    },

    async ping() {
      try {
        const client = await getClient()
        await client.execute('SELECT 1')
        return true
      } catch {
        return false
      }
    },

    async listPage(vault, collection, cursor, limit = 100) {
      await ensureSchema()
      const client = await getClient()
      const afterId = cursor ?? ''
      const result = await client.execute({
        sql: `SELECT id, v, ts, env, iv, data, by, tier, elevated_by, det FROM ${tableName}
              WHERE vault = ? AND collection = ? AND id > ?
              ORDER BY id LIMIT ?`,
        args: [vault, collection, afterId, limit + 1],
      })
      const hasMore = result.rows.length > limit
      const trimmed = hasMore ? result.rows.slice(0, limit) : result.rows
      const items = trimmed.map(r => ({ id: r.id as string, envelope: rowToEnvelope(r) }))
      const res: ListPageResult = {
        items,
        nextCursor: hasMore ? (trimmed[trimmed.length - 1]!.id as string) : null,
      }
      return res
    },

    async tx(ops: readonly TxOp[]) {
      await ensureSchema()
      const client = await getClient()
      if (client.batch) {
        // Guards run FIRST, inside the same atomic batch as the writes: a
        // conditional UPDATE that matches zero rows cannot abort a libSQL
        // batch, so each expectedVersion becomes a statement that RAISES
        // (NOT NULL violation on `v`) exactly when its precondition fails
        // against the pre-batch state — aborting and rolling back the
        // entire implicit transaction (#37).
        //   expectedVersion 0  → row must NOT exist (create-only)
        //   expectedVersion N  → row must exist at exactly v = N
        const guarded = ops.filter(op => op.expectedVersion !== undefined)
        const statements: { sql: string; args?: readonly unknown[] }[] = []
        for (const op of guarded) {
          const clause = op.expectedVersion === 0
            ? `EXISTS (SELECT 1 FROM ${tableName} WHERE vault = ? AND collection = ? AND id = ?)`
            : `NOT EXISTS (SELECT 1 FROM ${tableName} WHERE vault = ? AND collection = ? AND id = ? AND v = ?)`
          const args = op.expectedVersion === 0
            ? [op.vault, op.collection, op.id]
            : [op.vault, op.collection, op.id, op.expectedVersion]
          statements.push({
            sql:
              `INSERT INTO ${tableName} (vault, collection, id, v, ts, iv, data)
               SELECT '', '', '', NULL, '', '', '' WHERE ${clause}`,
            args,
          })
        }
        for (const op of ops) {
          if (op.type === 'put') {
            if (!op.envelope) throw new Error(`tx put op missing envelope for ${op.id}`)
            statements.push({
              sql:
                `INSERT INTO ${tableName} (vault, collection, id, v, ts, env, iv, data)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                 ON CONFLICT(vault, collection, id) DO UPDATE SET
                   v = excluded.v, ts = excluded.ts, env = excluded.env, iv = excluded.iv, data = excluded.data`,
              args: [
                op.vault, op.collection, op.id, op.envelope._v, op.envelope._ts, JSON.stringify(op.envelope),
                op.envelope._iv, op.envelope._data,
              ],
            })
          } else {
            statements.push({
              sql: `DELETE FROM ${tableName} WHERE vault = ? AND collection = ? AND id = ?`,
              args: [op.vault, op.collection, op.id],
            })
          }
        }
        try {
          await client.batch(statements)
        } catch (err) {
          // The batch rolled back. Re-probe each guarded op against the
          // (restored) pre-batch state; a mismatch identifies the tripped
          // guard → ConflictError. No mismatch found (e.g. an unrelated
          // SQL error) → rethrow the original.
          for (const op of guarded) {
            const check = await client.execute({
              sql: `SELECT v FROM ${tableName} WHERE vault = ? AND collection = ? AND id = ?`,
              args: [op.vault, op.collection, op.id],
            })
            const row = check.rows[0] as { v: number } | undefined
            const conflicted = op.expectedVersion === 0 ? row !== undefined : row?.v !== op.expectedVersion
            if (conflicted) {
              throw new ConflictError(
                row?.v ?? 0,
                `tx version conflict on ${op.collection}/${op.id}: expected ${op.expectedVersion}, found ${row?.v ?? 'no row'}`,
              )
            }
          }
          throw err
        }
        return
      }
      // Fallback: no batch API — sequential execute (no atomic guarantee).
      for (const op of ops) {
        if (op.type === 'put') {
          if (!op.envelope) throw new Error(`tx put op missing envelope for ${op.id}`)
          await upsert(op.vault, op.collection, op.id, op.envelope, op.expectedVersion)
        } else {
          await store.delete(op.vault, op.collection, op.id)
        }
      }
    },
  }

  return store
}

// ─── Store-locator descriptor (#58 — `cloud` class, opaque-client tier) ──

/**
 * Serializable location of a Turso store. `url` is REQUIRED — #58 flags
 * that today the URL is captured inside a `clientFactory` closure and
 * therefore invisible; putting it on the address states which database a
 * persisted descriptor refers to.
 */
export interface TursoAddress {
  /**
   * `@libsql/client({ url })` connection URL. Required — states which
   * database a persisted descriptor refers to. Identity-only: not consumed
   * by the factory (the connection, built from `binding.client` or
   * `binding.clientFactory`, already carries it).
   */
  readonly url: string
  /** Maps to `TursoStoreOptions.tableName`. Default `'noydb_envelopes'` when omitted. */
  readonly table?: string
}

/** Serializable tuning carried on the descriptor (never credentials). */
export interface TursoDescriptorOptions {
  readonly autoMigrate?: boolean
  readonly clockUncertaintyMs?: number
}

/**
 * Device-local supplement resolved at `resolve()` time. `to-turso` is the
 * one store in this tier that CAN construct its own connection — given
 * `clientFactory` plus `credentials` — so its binding accepts either a
 * pre-built `client` or a `clientFactory` to build one. Never serialized
 * into a pod alongside the descriptor.
 */
export interface TursoBinding {
  readonly client?: LibsqlClient
  readonly clientFactory?: (authToken: string) => LibsqlClient
}

/**
 * Builds the `StoreDescriptor` form of a `toTurso()` store:
 * `kind: 'turso'`, `class: 'cloud'`, with the identity address and the
 * serializable tuning as `options`. Credentialless by construction — the
 * live connection arrives via `binding.client` (or `binding.clientFactory`
 * + `opts.credentials`) at `resolve()` time.
 */
export function tursoStoreDescriptor(address: TursoAddress, options?: TursoDescriptorOptions): StoreDescriptor {
  return { kind: 'turso', class: 'cloud', address, ...(options !== undefined && { options }) }
}

/**
 * `StoreFactory` for `to-turso`: reconstructs the same store `toTurso()`
 * builds, from a descriptor produced by {@link tursoStoreDescriptor}.
 * `opts.binding.client` or `opts.binding.clientFactory` is required — this
 * store cannot build a connection from `address` alone.
 */
export const tursoStoreFactory: StoreFactory = (descriptor, opts) => {
  const address = descriptor.address as TursoAddress
  const { autoMigrate, clockUncertaintyMs } = (descriptor.options ?? {}) as TursoDescriptorOptions
  const binding = (opts.binding ?? {}) as TursoBinding
  if (!address.url) {
    throw new Error(
      '@noy-db/to-turso: resolving this descriptor requires `address.url` — ' +
      'a persisted descriptor must state which database it refers to.',
    )
  }
  if (!binding.client && !binding.clientFactory) {
    throw new Error(
      '@noy-db/to-turso: resolving this descriptor requires `binding.client` or `binding.clientFactory` — ' +
      'this store does not construct its own connection. ' +
      'Pass one: locator.resolve(descriptor, { binding: { client } }) or ' +
      'locator.resolve(descriptor, { binding: { clientFactory }, credentials }).',
    )
  }
  return toTurso({
    ...(autoMigrate !== undefined && { autoMigrate }),
    ...(clockUncertaintyMs !== undefined && { clockUncertaintyMs }),
    ...(address.table !== undefined && { tableName: address.table }),
    ...(binding.client !== undefined && { client: binding.client }),
    ...(binding.clientFactory !== undefined && { clientFactory: binding.clientFactory }),
    ...(opts.credentials !== undefined && { credentials: opts.credentials }),
  })
}

/** Registers {@link tursoStoreFactory} under the `'turso'` kind on `locator`. */
export function registerTursoStore(locator: StoreLocator): void {
  locator.register('turso', tursoStoreFactory)
}
