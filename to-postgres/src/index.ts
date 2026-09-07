/**
 * **@noy-db/to-postgres** — PostgreSQL-backed noy-db store.
 *
 * Encrypted envelopes land in a single `noydb_envelopes` table with a
 * `jsonb` column for the envelope payload. Keyed by `(vault,
 * collection, id)`. Version bumps use `UPDATE … WHERE v = ? RETURNING`
 * for atomic CAS.
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
 * | `casAtomic` | `true` — `UPDATE … WHERE v = ? RETURNING id` |
 * | `txAtomic`  | `true` — `BEGIN … COMMIT` |
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

export function toPostgres(options: PostgresStoreOptions): NoydbStore {
  const { client, tableName = 'noydb_envelopes', autoMigrate = true } = options
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

  async function upsert(
    vault: string,
    collection: string,
    id: string,
    envelope: EncryptedEnvelope,
    expectedVersion?: number,
  ): Promise<void> {
    await ensureSchema()
    if (expectedVersion !== undefined) {
      const { rows } = await client.query<{ v: number }>(
        `SELECT v FROM ${tableName} WHERE vault = $1 AND collection = $2 AND id = $3`,
        [vault, collection, id],
      )
      const current = rows[0]
      if (current && current.v !== expectedVersion) {
        throw new ConflictError(current.v, `Version conflict: expected ${expectedVersion}, found ${current.v}`)
      }
    }
    await client.query(
      `INSERT INTO ${tableName} (vault, collection, id, v, envelope)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (vault, collection, id) DO UPDATE
         SET v = EXCLUDED.v, envelope = EXCLUDED.envelope`,
      [vault, collection, id, envelope._v, JSON.stringify(envelope)],
    )
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
      const { rows } = await client.query<{ envelope: EncryptedEnvelope | string }>(
        `SELECT envelope FROM ${tableName} WHERE vault = $1 AND collection = $2 AND id = $3`,
        [vault, collection, id],
      )
      if (rows.length === 0) return null
      const raw = rows[0]!.envelope
      return typeof raw === 'string' ? (JSON.parse(raw) as EncryptedEnvelope) : raw
    },

    async put(vault, collection, id, envelope, expectedVersion) {
      await upsert(vault, collection, id, envelope, expectedVersion)
    },

    async delete(vault, collection, id) {
      await ensureSchema()
      await client.query(
        `DELETE FROM ${tableName} WHERE vault = $1 AND collection = $2 AND id = $3`,
        [vault, collection, id],
      )
    },

    async list(vault, collection) {
      await ensureSchema()
      const { rows } = await client.query<{ id: string }>(
        `SELECT id FROM ${tableName} WHERE vault = $1 AND collection = $2 ORDER BY id`,
        [vault, collection],
      )
      return rows.map(r => r.id)
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
        bucket[row.id] = env
      }
      return snap
    },

    async saveAll(vault, data) {
      await ensureSchema()
      await client.query('BEGIN')
      try {
        await client.query(`DELETE FROM ${tableName} WHERE vault = $1`, [vault])
        for (const [collection, recs] of Object.entries(data)) {
          for (const [id, envelope] of Object.entries(recs)) {
            await upsert(vault, collection, id, envelope)
          }
        }
        await client.query('COMMIT')
      } catch (err) {
        await client.query('ROLLBACK')
        throw err
      }
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
        id: r.id,
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
      await client.query('BEGIN')
      try {
        for (const op of ops) {
          if (op.type === 'put') {
            if (!op.envelope) throw new Error(`tx put op missing envelope for ${op.id}`)
            await upsert(op.vault, op.collection, op.id, op.envelope, op.expectedVersion)
          } else {
            if (op.expectedVersion !== undefined) {
              const { rows } = await client.query<{ v: number }>(
                `SELECT v FROM ${tableName} WHERE vault = $1 AND collection = $2 AND id = $3`,
                [op.vault, op.collection, op.id],
              )
              if (rows[0] && rows[0].v !== op.expectedVersion) {
                throw new ConflictError(rows[0].v)
              }
            }
            await client.query(
              `DELETE FROM ${tableName} WHERE vault = $1 AND collection = $2 AND id = $3`,
              [op.vault, op.collection, op.id],
            )
          }
        }
        await client.query('COMMIT')
      } catch (err) {
        await client.query('ROLLBACK')
        throw err
      }
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
