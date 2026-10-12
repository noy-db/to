/**
 * **@noy-db/to-mysql** — MySQL / MariaDB-backed noy-db store.
 *
 * Parallel to `@noy-db/to-postgres` — same KV-shape, same transaction
 * story, adapted to MySQL 8+ `JSON` columns and `?`-style placeholders.
 *
 * ## Driver — bring your own
 *
 * Any client whose `execute(sql, params?)` returns `[rows, fields]`
 * (the `mysql2` convention) works:
 *
 *   - `mysql2/promise` — `createPool()` or `createConnection()`
 *   - PlanetScale's serverless driver — through a shim; `saveAll`/`tx` are
 *     atomic only if the shim keeps one session across calls
 *   - Any pool wrapper that preserves the mysql2 Promise interface
 *
 * ## Capabilities
 *
 * | Capability  | Value |
 * |-------------|-------|
 * | `casAtomic` | `true` — `UPDATE … WHERE v = ?` + row-count check |
 * | `txAtomic`  | `true` — `START TRANSACTION … COMMIT` on one connection (checked out of a pool) |
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

/** Duck-typed subset of the mysql2 Pool/Connection promise API. */
export interface MysqlClient {
  execute<T = unknown>(sql: string, params?: readonly unknown[]): Promise<[T[], unknown]>
  query?<T = unknown>(sql: string): Promise<[T[], unknown]>
}

/** A connection checked out of a pool (mysql2 `PromisePoolConnection`). */
export interface MysqlPoolConnection extends MysqlClient {
  release(): void
}

/**
 * Duck-typed subset of mysql2 `PromisePool`. `pool.execute()` runs each
 * statement on whichever connection is free, so a transaction must run on
 * one connection taken with `getConnection()`. A plain `Connection` has no
 * `getConnection`, which is what tells the two apart.
 */
export interface MysqlPool extends MysqlClient {
  getConnection(): Promise<MysqlPoolConnection>
}

function isPool(client: MysqlClient): client is MysqlPool {
  return typeof (client as Partial<MysqlPool>).getConnection === 'function'
}

export interface MysqlStoreOptions {
  readonly client: MysqlClient
  /** Custom table name. Default `'noydb_envelopes'`. */
  readonly tableName?: string
  /** Run the CREATE TABLE DDL on store construction (async, lazy). Default `true`. */
  readonly autoMigrate?: boolean
}

export function toMysql(options: MysqlStoreOptions): NoydbStore {
  const { client, tableName = 'noydb_envelopes', autoMigrate = true } = options
  let schemaReady: Promise<void> | null = null

  async function runDDL(sql: string, q: MysqlClient = client): Promise<void> {
    if (q.query) await q.query(sql)
    else await q.execute(sql)
  }

  /**
   * Runs `fn` between START TRANSACTION and COMMIT on ONE connection — a
   * pool's checked-out connection, or the given client itself (already
   * connection-pinned). Through `pool.execute()` each statement could land on
   * a different connection: the DELETE autocommits and ROLLBACK is a no-op
   * (family#144).
   */
  async function inTransaction(fn: (q: MysqlClient) => Promise<void>): Promise<void> {
    const pinned = isPool(client) ? await client.getConnection() : null
    const q = pinned ?? client
    try {
      await runDDL('START TRANSACTION', q)
      try {
        await fn(q)
        await runDDL('COMMIT', q)
      } catch (err) {
        try { await runDDL('ROLLBACK', q) } catch { /* keep the original error */ }
        throw err
      }
    } finally {
      pinned?.release()
    }
  }

  async function ensureSchema(): Promise<void> {
    if (!autoMigrate) return
    if (!schemaReady) {
      schemaReady = (async () => {
        await runDDL(
          `CREATE TABLE IF NOT EXISTS ${tableName} (
             vault VARCHAR(255) NOT NULL,
             collection VARCHAR(255) NOT NULL,
             id VARCHAR(255) NOT NULL,
             v BIGINT NOT NULL,
             envelope JSON NOT NULL,
             PRIMARY KEY (vault, collection, id),
             INDEX idx_${tableName}_vc (vault, collection)
           )`,
        )
      })()
    }
    await schemaReady
  }

  async function upsert(
    q: MysqlClient,
    vault: string,
    collection: string,
    id: string,
    envelope: EncryptedEnvelope,
    expectedVersion?: number,
  ): Promise<void> {
    await ensureSchema()
    if (expectedVersion !== undefined) {
      const [rows] = await q.execute<{ v: number }>(
        `SELECT v FROM ${tableName} WHERE vault = ? AND collection = ? AND id = ?`,
        [vault, collection, id],
      )
      const current = rows[0]
      if (current && Number(current.v) !== expectedVersion) {
        throw new ConflictError(Number(current.v), `Version conflict: expected ${expectedVersion}, found ${current.v}`)
      }
    }
    await q.execute(
      `INSERT INTO ${tableName} (vault, collection, id, v, envelope)
       VALUES (?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE v = VALUES(v), envelope = VALUES(envelope)`,
      [vault, collection, id, envelope._v, JSON.stringify(envelope)],
    )
  }

  function parseEnvelope(raw: unknown): EncryptedEnvelope {
    return typeof raw === 'string' ? (JSON.parse(raw) as EncryptedEnvelope) : (raw as EncryptedEnvelope)
  }

  const store: NoydbStore = {
    name: 'mysql',
    capabilities: {
      casAtomic: true,
      txAtomic: true,
      auth: { kind: 'api-key', required: true, flow: 'static' },
    },

    async get(vault, collection, id) {
      await ensureSchema()
      const [rows] = await client.execute<{ envelope: unknown }>(
        `SELECT envelope FROM ${tableName} WHERE vault = ? AND collection = ? AND id = ?`,
        [vault, collection, id],
      )
      if (rows.length === 0) return null
      return parseEnvelope(rows[0]!.envelope)
    },

    async put(vault, collection, id, envelope, expectedVersion) {
      await upsert(client, vault, collection, id, envelope, expectedVersion)
    },

    async delete(vault, collection, id) {
      await ensureSchema()
      await client.execute(
        `DELETE FROM ${tableName} WHERE vault = ? AND collection = ? AND id = ?`,
        [vault, collection, id],
      )
    },

    async list(vault, collection) {
      await ensureSchema()
      const [rows] = await client.execute<{ id: string }>(
        `SELECT id FROM ${tableName} WHERE vault = ? AND collection = ? ORDER BY id`,
        [vault, collection],
      )
      return rows.map(r => r.id)
    },

    async loadAll(vault) {
      await ensureSchema()
      const [rows] = await client.execute<{ id: string; collection: string; v: number; envelope: unknown }>(
        `SELECT id, collection, v, envelope FROM ${tableName} WHERE vault = ?`,
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
        bucket[row.id] = parseEnvelope(row.envelope)
      }
      return snap
    },

    async saveAll(vault, data) {
      await ensureSchema()
      await inTransaction(async (q) => {
        await q.execute(`DELETE FROM ${tableName} WHERE vault = ?`, [vault])
        for (const [collection, recs] of Object.entries(data)) {
          for (const [id, envelope] of Object.entries(recs)) {
            await upsert(q, vault, collection, id, envelope)
          }
        }
      })
    },

    async ping() {
      try {
        await client.execute('SELECT 1')
        return true
      } catch {
        return false
      }
    },

    async listPage(vault, collection, cursor, limit = 100) {
      await ensureSchema()
      const afterId = cursor ?? ''
      const [rows] = await client.execute<{ id: string; envelope: unknown }>(
        `SELECT id, envelope FROM ${tableName}
         WHERE vault = ? AND collection = ? AND id > ?
         ORDER BY id LIMIT ?`,
        [vault, collection, afterId, limit + 1],
      )
      const hasMore = rows.length > limit
      const trimmed = hasMore ? rows.slice(0, limit) : rows
      const items = trimmed.map(r => ({ id: r.id, envelope: parseEnvelope(r.envelope) }))
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
            if (op.expectedVersion !== undefined) {
              const [rows] = await q.execute<{ v: number }>(
                `SELECT v FROM ${tableName} WHERE vault = ? AND collection = ? AND id = ?`,
                [op.vault, op.collection, op.id],
              )
              if (rows[0] && Number(rows[0].v) !== op.expectedVersion) {
                throw new ConflictError(Number(rows[0].v))
              }
            }
            await q.execute(
              `DELETE FROM ${tableName} WHERE vault = ? AND collection = ? AND id = ?`,
              [op.vault, op.collection, op.id],
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
 * Serializable location of a MySQL store. `database` is identity-only —
 * the connection lives in the injected `binding.client`, so the factory
 * does not consume it.
 */
export interface MysqlAddress {
  /** Identity-only: not consumed by the factory (the connection carries it). */
  readonly database?: string
  /** Maps to `MysqlStoreOptions.tableName`. Default `'noydb_envelopes'` when omitted. */
  readonly table?: string
}

/** Serializable tuning carried on the descriptor (never credentials). */
export interface MysqlDescriptorOptions {
  readonly autoMigrate?: boolean
}

/**
 * Device-local supplement resolved at `resolve()` time — the live
 * `MysqlClient` this store has no way to construct itself. Never
 * serialized into a pod alongside the descriptor.
 */
export interface MysqlBinding {
  readonly client: MysqlClient
}

/**
 * Builds the `StoreDescriptor` form of a `toMysql()` store:
 * `kind: 'mysql'`, `class: 'cloud'`, with the identity address and the
 * serializable tuning as `options`. Credentialless by construction — the
 * live connection arrives via `binding.client` at `resolve()` time.
 */
export function mysqlStoreDescriptor(address: MysqlAddress, options?: MysqlDescriptorOptions): StoreDescriptor {
  return { kind: 'mysql', class: 'cloud', address, ...(options !== undefined && { options }) }
}

/**
 * `StoreFactory` for `to-mysql`: reconstructs the same store `toMysql()`
 * builds, from a descriptor produced by {@link mysqlStoreDescriptor}.
 * `opts.binding.client` is required — this store has no client library of
 * its own and cannot build a connection from `address` alone.
 */
export const mysqlStoreFactory: StoreFactory = (descriptor, opts) => {
  const address = descriptor.address as MysqlAddress
  const { autoMigrate } = (descriptor.options ?? {}) as MysqlDescriptorOptions
  const binding = (opts.binding ?? {}) as Partial<MysqlBinding>
  if (!binding.client) {
    throw new Error(
      '@noy-db/to-mysql: resolving this descriptor requires `binding.client` — ' +
      'this store does not construct its own connection. ' +
      'Pass one: locator.resolve(descriptor, { binding: { client } }).',
    )
  }
  return toMysql({
    ...(autoMigrate !== undefined && { autoMigrate }),
    ...(address.table !== undefined && { tableName: address.table }),
    client: binding.client,
  })
}

/** Registers {@link mysqlStoreFactory} under the `'mysql'` kind on `locator`. */
export function registerMysqlStore(locator: StoreLocator): void {
  locator.register('mysql', mysqlStoreFactory)
}
