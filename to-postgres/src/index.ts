/**
 * **@noy-db/to-postgres** — PostgreSQL-backed noy-db store.
 *
 * Encrypted envelopes land in a single `noydb_envelopes` table with a
 * `jsonb` column for the envelope payload. Keyed by `(vault,
 * collection, id)`. A versioned write is one conditional statement —
 * `UPDATE … WHERE v = $n RETURNING id`, or `INSERT … ON CONFLICT DO
 * NOTHING RETURNING id` for a create (`expectedVersion` 0) — so CAS is
 * atomic without a transaction.
 *
 * ## Driver — bring your own
 *
 * Any client that exposes a `query(sql, params?)` → `{ rows: any[] }`
 * async method works:
 *
 *   - `pg` (node-postgres) — `new Client()` or `new Pool()`
 *   - `postgres` (postgres.js) — with a light shim, see README
 *   - `@vercel/postgres` / `@neondatabase/serverless` — drop-in
 *   - `drizzle-orm` raw pool reference
 *
 * The store never imports a Postgres driver directly; the consumer
 * installs the one they prefer.
 *
 * ## Capabilities
 *
 * | Capability  | Value |
 * |-------------|-------|
 * | `casAtomic` | `true` — `UPDATE … WHERE v = $n RETURNING id` |
 * | `txAtomic`  | `true` — `BEGIN … COMMIT` on one connection (checked out of a `Pool`) |
 * | `listPage`  | ✓ — keyset paging by `id` |
 * | `ping`      | ✓ — `SELECT 1` round-trip |
 *
 * @packageDocumentation
 */

import type {
  NoydbStore,
  EncryptedEnvelope,
  VaultSnapshot,
  TxOp,
  ListPageResult,
  StoreDescriptor,
  StoreFactory,
  StoreLocator,
} from '@noy-db/hub/to'
import { ConflictError } from '@noy-db/hub/to'

/** Duck-typed subset of the node-postgres `Client` API. */
export interface PostgresClient {
  query<T = unknown>(sql: string, params?: readonly unknown[]): Promise<{ rows: T[] }>
}

/** A connection checked out of a pool (node-postgres `PoolClient`). */
export interface PostgresPoolClient extends PostgresClient {
  release(): void
}

/**
 * Duck-typed subset of node-postgres `Pool` (Neon's and Vercel's pools
 * extend it). `pool.query()` runs each statement on whichever connection is
 * free, so a transaction must run on one connection taken with `connect()`.
 */
export interface PostgresPool extends PostgresClient {
  connect(): Promise<PostgresPoolClient>
  readonly totalCount: number
}

/**
 * Not `typeof connect === 'function'` alone: `pg.Client` has `connect()` too,
 * and calling it on a connected Client throws. `totalCount` is documented on
 * `Pool` only.
 */
function isPool(client: PostgresClient): client is PostgresPool {
  const c = client as Partial<PostgresPool>
  return typeof c.connect === 'function' && typeof c.totalCount === 'number'
}

export interface PostgresStoreOptions {
  readonly client: PostgresClient
  /** Custom table name. Default `'noydb_envelopes'`. */
  readonly tableName?: string
  /** Run the CREATE TABLE DDL on store construction (async, lazy). Default `true`. */
  readonly autoMigrate?: boolean
}

interface Row {
  id: string
  collection: string
  v: number
  envelope: EncryptedEnvelope
}

/**
 * `tableName` is interpolated into every statement — identifiers cannot be
 * bound as parameters — and it can arrive from a descriptor's
 * `address.table`, which travels inside a pod. So only a plain identifier is
 * accepted (family#148); that also keeps `idx_${tableName}_…` a valid name.
 */
function assertTableName(tableName: string): void {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(tableName)) {
    throw new Error(`@noy-db/to-postgres: tableName must match /^[A-Za-z_][A-Za-z0-9_]*$/, got ${JSON.stringify(tableName)}`)
  }
}

/**
 * Reversible id encoding at the Postgres boundary (family#174), the same codec
 * as to-file's. `text` refuses a 0x00 byte outright ("invalid byte sequence
 * for encoding UTF8"), and hub joins partitioned sequence and period keys with
 * `\x00`, so every id is bound encoded and read back decoded. `%` is escaped
 * FIRST or `a%00b` and `a\x00b` share one row; the scope is `%` and NUL only.
 */
function encodeId(id: string): string {
  return id.replace(/%/g, '%25').replace(/\0/g, '%00')
}

/** Exact inverse of {@link encodeId}, in ONE pass (`%2500` → `%00`). */
function decodeId(id: string): string {
  return id.replace(/%(25|00)/g, (_m, code: string) => (code === '25' ? '%' : '\0'))
}

/**
 * The key a pre-family#174 row holds for `id`: encoding `%` moved every
 * existing id containing one. ⛔ Null whenever that raw key is ANOTHER id's
 * encoded key (`a%00b` is where `a\x00b` lives), when nothing moved, and for
 * an id holding a NUL, which `text` never stored.
 */
function legacyKey(id: string): string | null {
  return id.includes('\0') || !id.includes('%') || encodeId(decodeId(id)) === id ? null : id
}

export function toPostgres(options: PostgresStoreOptions): NoydbStore {
  const { client, tableName = 'noydb_envelopes', autoMigrate = true } = options
  assertTableName(tableName)
  let schemaReady: Promise<void> | null = null

  async function ensureSchema(): Promise<void> {
    if (!autoMigrate) return
    if (!schemaReady) {
      schemaReady = (async () => {
        await client.query(`
          CREATE TABLE IF NOT EXISTS ${tableName} (
            vault      TEXT NOT NULL,
            collection TEXT NOT NULL,
            id         TEXT NOT NULL,
            v          BIGINT NOT NULL,
            envelope   JSONB NOT NULL,
            PRIMARY KEY (vault, collection, id)
          );
          CREATE INDEX IF NOT EXISTS idx_${tableName}_vault_collection
            ON ${tableName} (vault, collection);
        `)
      })()
    }
    await schemaReady
  }

  /**
   * Runs `fn` between BEGIN and COMMIT on ONE connection — a pool's checked-out
   * client, or the given client itself (already connection-pinned). Sending
   * BEGIN/COMMIT through `pool.query()` would put each on a different
   * connection: the DELETE autocommits and ROLLBACK is a no-op (family#144).
   */
  async function inTransaction(fn: (q: PostgresClient) => Promise<void>): Promise<void> {
    const pinned = isPool(client) ? await client.connect() : null
    const q = pinned ?? client
    try {
      await q.query('BEGIN')
      try {
        await fn(q)
        await q.query('COMMIT')
      } catch (err) {
        try { await q.query('ROLLBACK') } catch { /* keep the original error */ }
        throw err
      }
    } finally {
      pinned?.release()
    }
  }

  async function upsert(
    q: PostgresClient,
    vault: string,
    collection: string,
    id: string,
    envelope: EncryptedEnvelope,
    expectedVersion?: number,
  ): Promise<void> {
    await ensureSchema()
    id = await adoptLegacy(q, vault, collection, id)
    if (expectedVersion !== undefined) {
      // One statement each, so two writers holding the same expectedVersion
      // cannot both pass (family#145): 0 → create-only, N → the row must exist
      // at exactly v = N. Zero rows back means the precondition failed.
      const { rows } = expectedVersion === 0
        ? await q.query<{ id: string }>(
          `INSERT INTO ${tableName} (vault, collection, id, v, envelope)
           VALUES ($1, $2, $3, $4, $5)
           ON CONFLICT (vault, collection, id) DO NOTHING
           RETURNING id`,
          [vault, collection, id, envelope._v, JSON.stringify(envelope)],
        )
        : await q.query<{ id: string }>(
          `UPDATE ${tableName} SET v = $4, envelope = $5
           WHERE vault = $1 AND collection = $2 AND id = $3 AND v = $6
           RETURNING id`,
          [vault, collection, id, envelope._v, JSON.stringify(envelope), expectedVersion],
        )
      if (rows.length === 0) throw conflict(expectedVersion, await probeVersion(q, vault, collection, id))
      return
    }
    await q.query(
      `INSERT INTO ${tableName} (vault, collection, id, v, envelope)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (vault, collection, id) DO UPDATE
         SET v = EXCLUDED.v, envelope = EXCLUDED.envelope`,
      [vault, collection, id, envelope._v, JSON.stringify(envelope)],
    )
  }

  /**
   * Moves a pre-family#174 row onto its encoded key, in one statement, and
   * returns the encoded key. Run before any write or delete, so a versioned put
   * sees the legacy row's version instead of "absent", and the id lists once.
   * A no-op unless the id holds a `%`.
   */
  async function adoptLegacy(q: PostgresClient, vault: string, collection: string, id: string): Promise<string> {
    const key = encodeId(id)
    const legacy = legacyKey(id)
    if (legacy !== null) {
      await q.query(
        `UPDATE ${tableName} SET id = $4
         WHERE vault = $1 AND collection = $2 AND id = $3
           AND NOT EXISTS (SELECT 1 FROM ${tableName} WHERE vault = $1 AND collection = $2 AND id = $4)`,
        [vault, collection, legacy, key],
      )
    }
    return key
  }

  /** Current version of a row, or `null` when it is absent. */
  async function probeVersion(q: PostgresClient, vault: string, collection: string, id: string): Promise<number | null> {
    const { rows } = await q.query<{ v: number }>(
      `SELECT v FROM ${tableName} WHERE vault = $1 AND collection = $2 AND id = $3`,
      [vault, collection, id],
    )
    return rows[0] ? Number(rows[0].v) : null
  }

  function conflict(expectedVersion: number, found: number | null): ConflictError {
    return new ConflictError(found ?? 0, `Version conflict: expected ${expectedVersion}, found ${found ?? 'no row'}`)
  }

  const store: NoydbStore = {
    name: 'postgres',
    capabilities: {
      casAtomic: true,
      txAtomic: true,
      auth: { kind: 'api-key', required: true, flow: 'static' },
    },

    async get(vault, collection, id) {
      await ensureSchema()
      // The encoded key first, then a pre-family#174 row's raw one (see `legacyKey`).
      const keys = [encodeId(id), legacyKey(id)].filter((k): k is string => k !== null)
      const { rows } = await client.query<{ id: string; envelope: EncryptedEnvelope | string }>(
        `SELECT id, envelope FROM ${tableName} WHERE vault = $1 AND collection = $2 AND id = ANY($3::text[])`,
        [vault, collection, keys],
      )
      rows.sort((a, b) => keys.indexOf(a.id) - keys.indexOf(b.id))
      if (rows.length === 0) return null
      const raw = rows[0]!.envelope
      return typeof raw === 'string' ? (JSON.parse(raw) as EncryptedEnvelope) : raw
    },

    async put(vault, collection, id, envelope, expectedVersion) {
      await upsert(client, vault, collection, id, envelope, expectedVersion)
    },

    async delete(vault, collection, id) {
      await ensureSchema()
      // A pre-family#174 row under its raw key goes too, or it would resurface.
      const keys = [encodeId(id), legacyKey(id)].filter((k): k is string => k !== null)
      await client.query(
        `DELETE FROM ${tableName} WHERE vault = $1 AND collection = $2 AND id = ANY($3::text[])`,
        [vault, collection, keys],
      )
    },

    async list(vault, collection) {
      await ensureSchema()
      const { rows } = await client.query<{ id: string }>(
        `SELECT id FROM ${tableName} WHERE vault = $1 AND collection = $2 ORDER BY id`,
        [vault, collection],
      )
      return rows.map(r => decodeId(r.id))
    },

    async loadAll(vault) {
      await ensureSchema()
      const { rows } = await client.query<Row>(
        `SELECT id, collection, v, envelope FROM ${tableName} WHERE vault = $1`,
        [vault],
      )
      const snap: VaultSnapshot = {}
      for (const row of rows) {
        // Internal collections (`_keyring`, `_sync`) are the vault's own
        // bookkeeping and must not appear in a snapshot — required by the store
        // contract, with `@noy-db/to-file` setting the reference behaviour via
        // the same `_`-prefix rule.
        if (row.collection.startsWith('_')) continue
        const bucket = snap[row.collection] ?? (snap[row.collection] = {})
        const env = typeof row.envelope === 'string'
          ? (JSON.parse(row.envelope) as EncryptedEnvelope)
          : row.envelope
        bucket[decodeId(row.id)] = env
      }
      return snap
    },

    async saveAll(vault, data) {
      await ensureSchema()
      await inTransaction(async (q) => {
        // family#147 — saveAll REPLACES every non-underscore collection; an underscore
        // one (`_keyring`) is never pruned, only overwritten when the snapshot carries it.
        await q.query(`DELETE FROM ${tableName} WHERE vault = $1 AND substr(collection, 1, 1) <> '_'`, [vault])
        for (const [collection, recs] of Object.entries(data)) {
          for (const [id, envelope] of Object.entries(recs)) {
            await upsert(q, vault, collection, id, envelope)
          }
        }
      })
    },

    async ping() {
      try {
        await client.query('SELECT 1')
        return true
      } catch {
        return false
      }
    },

    async listPage(vault, collection, cursor, limit = 100) {
      await ensureSchema()
      // The cursor is the last row's STORED (encoded) key: rows sort by it.
      const afterId = cursor ?? ''
      // Fetch limit+1 so we can distinguish "exactly N rows remain" from
      // "more rows remain" without a second round-trip.
      const { rows } = await client.query<{ id: string; envelope: EncryptedEnvelope | string }>(
        `SELECT id, envelope FROM ${tableName}
         WHERE vault = $1 AND collection = $2 AND id > $3
         ORDER BY id LIMIT $4`,
        [vault, collection, afterId, limit + 1],
      )
      const hasMore = rows.length > limit
      const trimmed = hasMore ? rows.slice(0, limit) : rows
      const items = trimmed.map(r => ({
        id: decodeId(r.id),
        envelope: typeof r.envelope === 'string'
          ? (JSON.parse(r.envelope) as EncryptedEnvelope)
          : r.envelope,
      }))
      const result: ListPageResult = {
        items,
        nextCursor: hasMore ? trimmed[trimmed.length - 1]!.id : null,
      }
      return result
    },

    async tx(ops: readonly TxOp[]) {
      await ensureSchema()
      await inTransaction(async (q) => {
        for (const op of ops) {
          if (op.type === 'put') {
            if (!op.envelope) throw new Error(`tx put op missing envelope for ${op.id}`)
            await upsert(q, op.vault, op.collection, op.id, op.envelope, op.expectedVersion)
          } else {
            const key = await adoptLegacy(q, op.vault, op.collection, op.id)
            if (op.expectedVersion !== undefined) {
              const { rows } = await q.query<{ id: string }>(
                `DELETE FROM ${tableName}
                 WHERE vault = $1 AND collection = $2 AND id = $3 AND v = $4
                 RETURNING id`,
                [op.vault, op.collection, key, op.expectedVersion],
              )
              if (rows.length === 0) {
                // Nothing deleted: the row is absent or at another version.
                // Absent satisfies expectedVersion 0 only (as in to-turso).
                const found = await probeVersion(q, op.vault, op.collection, key)
                if (op.expectedVersion !== 0 || found !== null) throw conflict(op.expectedVersion, found)
              }
              continue
            }
            await q.query(
              `DELETE FROM ${tableName} WHERE vault = $1 AND collection = $2 AND id = $3`,
              [op.vault, op.collection, key],
            )
          }
        }
      })
    },
  }

  return store
}

// ─── Store-locator descriptor (#58 — `cloud` class, opaque-client tier) ──

/**
 * Serializable location of a Postgres store. `database` and `schema` are
 * identity-only — the connection lives in the injected `binding.client`,
 * so the factory does not consume them.
 */
export interface PostgresAddress {
  /** Identity-only: not consumed by the factory (the connection carries it). */
  readonly database?: string
  /** Identity-only: not consumed by the factory (the connection carries it). */
  readonly schema?: string
  /** Maps to `PostgresStoreOptions.tableName`. Default `'noydb_envelopes'` when omitted. */
  readonly table?: string
}

/** Serializable tuning carried on the descriptor (never credentials). */
export interface PostgresDescriptorOptions {
  readonly autoMigrate?: boolean
}

/**
 * Device-local supplement resolved at `resolve()` time — the live
 * `PostgresClient` this store has no way to construct itself. Never
 * serialized into a pod alongside the descriptor.
 */
export interface PostgresBinding {
  readonly client: PostgresClient
}

/**
 * Builds the `StoreDescriptor` form of a `toPostgres()` store:
 * `kind: 'postgres'`, `class: 'cloud'`, with the identity address and the
 * serializable tuning as `options`. Credentialless by construction — the
 * live connection arrives via `binding.client` at `resolve()` time.
 */
export function postgresStoreDescriptor(address: PostgresAddress, options?: PostgresDescriptorOptions): StoreDescriptor {
  return { kind: 'postgres', class: 'cloud', address, ...(options !== undefined && { options }) }
}

/**
 * `StoreFactory` for `to-postgres`: reconstructs the same store
 * `toPostgres()` builds, from a descriptor produced by
 * {@link postgresStoreDescriptor}. `opts.binding.client` is required —
 * this store has no client library of its own and cannot build a
 * connection from `address` alone.
 */
export const postgresStoreFactory: StoreFactory = (descriptor, opts) => {
  const address = descriptor.address as PostgresAddress
  const { autoMigrate } = (descriptor.options ?? {}) as PostgresDescriptorOptions
  const binding = (opts.binding ?? {}) as Partial<PostgresBinding>
  if (!binding.client) {
    throw new Error(
      '@noy-db/to-postgres: resolving this descriptor requires `binding.client` — ' +
      'this store does not construct its own connection. ' +
      'Pass one: locator.resolve(descriptor, { binding: { client } }).',
    )
  }
  return toPostgres({
    ...(autoMigrate !== undefined && { autoMigrate }),
    ...(address.table !== undefined && { tableName: address.table }),
    client: binding.client,
  })
}

/** Registers {@link postgresStoreFactory} under the `'postgres'` kind on `locator`. */
export function registerPostgresStore(locator: StoreLocator): void {
  locator.register('postgres', postgresStoreFactory)
}
