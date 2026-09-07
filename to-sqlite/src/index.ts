/**
 * **@noy-db/to-sqlite** — SQLite-backed noy-db store.
 *
 * Single-file local database for 10K+ record vaults where file-per-record
 * (`@noy-db/to-file`) starts to feel heavy. Encrypted envelopes land in
 * a single `noydb_envelopes` table keyed by `(vault, collection, id)`.
 *
 * ## Runtime — bring your own driver
 *
 * noy-db ships zero SQLite dependencies. Pass any driver whose `Database`
 * handle exposes `prepare(sql)` + `run()` / `get()` / `all()`:
 *
 *   - `better-sqlite3` (most common, synchronous API)
 *   - `node:sqlite` (Node 22+, same synchronous API shape)
 *   - `bun:sqlite`
 *   - A custom duck-typed wrapper around async drivers
 *
 * The store's `ensureSchema()` call creates the table + index on first
 * use; pass `autoMigrate: false` if the schema is provisioned out-of-band.
 *
 * ## Capabilities
 *
 * | Capability  | Value |
 * |-------------|-------|
 * | `casAtomic` | `true` — `UPDATE … WHERE _v = ?` inside a transaction |
 * | `txAtomic`  | `true` — `BEGIN IMMEDIATE … COMMIT` |
 * | `listPage`  | ✓ — ordered `LIMIT/OFFSET` paging |
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

/**
 * Duck-typed `Database` interface — intentionally minimal so every
 * popular SQLite driver fits without an adapter shim.
 */
export interface SqliteDatabase {
  prepare(sql: string): SqliteStatement
  exec(sql: string): void
}

export interface SqliteStatement {
  run(...params: readonly unknown[]): unknown
  get(...params: readonly unknown[]): unknown
  all(...params: readonly unknown[]): readonly unknown[]
}

export interface SqliteStoreOptions {
  /** Open database handle from better-sqlite3 / node:sqlite / bun:sqlite. */
  readonly db: SqliteDatabase
  /** Custom table name. Default `'noydb_envelopes'`. */
  readonly tableName?: string
  /** Run the CREATE TABLE IF NOT EXISTS DDL on store construction. Default `true`. */
  readonly autoMigrate?: boolean
}

interface Row {
  vault: string
  collection: string
  id: string
  v: number
  ts: string
  env: string | null
  iv: string | null
  data: string | null
  by: string | null
  tier: number | null
  elevated_by: string | null
  det: string | null
  del: number | null
}

export function toSqlite(options: SqliteStoreOptions): NoydbStore {
  const { db, tableName = 'noydb_envelopes', autoMigrate = true } = options

  if (autoMigrate) {
    // New writes only populate vault/collection/id/v/ts/env — `env` is
    // `JSON.stringify(envelope)`, the ENTIRE envelope, so no field (including
    // ones this store doesn't know about, e.g. `_cek`/`_debug`) is ever
    // silently dropped. `v`/`ts` stay as real columns because CAS (`WHERE
    // v = ?`) and ordering need to query them without deserializing `env`.
    // iv/data are still written on every upsert (see `upsert`) so the
    // NOT NULL constraint keeps holding on tables created before this
    // migration; by/tier/elevated_by/det/del are LEGACY columns, kept
    // nullable for dual-read of rows written before this migration (see
    // `rowToEnvelope`) — no data migration script required (pre-1.0).
    db.exec(`
      CREATE TABLE IF NOT EXISTS ${tableName} (
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
      );
    `)
    // `CREATE TABLE IF NOT EXISTS` is a no-op against a table that already
    // exists from before this migration — it has no `env` column, so every
    // write/read would fail otherwise. `ALTER TABLE ADD COLUMN` is the only
    // way to backfill it; on a table that was just created fresh above (env
    // already in the DDL) this throws "duplicate column name", which is
    // swallowed as the expected no-op. Anything else rethrows.
    try {
      db.exec(`ALTER TABLE ${tableName} ADD COLUMN env TEXT`)
    } catch (err) {
      if (!(err instanceof Error) || !err.message.includes('duplicate column name')) throw err
    }
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_${tableName}_vault_collection
        ON ${tableName} (vault, collection);
      CREATE INDEX IF NOT EXISTS idx_${tableName}_vault_collection_ts
        ON ${tableName} (vault, collection, ts);
    `)
  }

  function rowToEnvelope(row: Row): EncryptedEnvelope {
    if (row.env != null) {
      return JSON.parse(row.env) as EncryptedEnvelope
    }
    // Legacy dual-read fallback: row written before the `env` migration —
    // reconstruct from the old per-column layout.
    const env: EncryptedEnvelope = {
      _noydb: 1,
      _v: row.v,
      _ts: row.ts,
      _iv: row.iv ?? '',
      _data: row.data ?? '',
      ...(row.by !== null && { _by: row.by }),
      ...(row.tier !== null && { _tier: row.tier }),
      ...(row.elevated_by !== null && { _elevatedBy: row.elevated_by }),
      ...(row.det !== null && { _det: JSON.parse(row.det) as Record<string, string> }),
      ...(row.del === 1 && { _del: true as const }),
    }
    return env
  }

  function upsert(
    vault: string,
    collection: string,
    id: string,
    envelope: EncryptedEnvelope,
    expectedVersion?: number,
  ): void {
    if (expectedVersion !== undefined) {
      const existing = db
        .prepare(`SELECT v FROM ${tableName} WHERE vault = ? AND collection = ? AND id = ?`)
        .get(vault, collection, id) as { v: number } | undefined
      if (existing && existing.v !== expectedVersion) {
        throw new ConflictError(existing.v, `Version conflict: expected ${expectedVersion}, found ${existing.v}`)
      }
    }

    db.prepare(
      `INSERT INTO ${tableName} (vault, collection, id, v, ts, env, iv, data)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(vault, collection, id) DO UPDATE SET
         v = excluded.v, ts = excluded.ts, env = excluded.env, iv = excluded.iv, data = excluded.data`,
    ).run(
      vault,
      collection,
      id,
      envelope._v,
      envelope._ts,
      JSON.stringify(envelope),
      envelope._iv,
      envelope._data,
    )
  }

  const store: NoydbStore = {
    name: 'sqlite',
    capabilities: {
      casAtomic: true,
      txAtomic: true,
      auth: { kind: 'none', required: false, flow: 'static' },
    },

    async get(vault, collection, id) {
      const row = db
        .prepare(`SELECT * FROM ${tableName} WHERE vault = ? AND collection = ? AND id = ?`)
        .get(vault, collection, id) as Row | undefined
      return row ? rowToEnvelope(row) : null
    },

    async put(vault, collection, id, envelope, expectedVersion) {
      upsert(vault, collection, id, envelope, expectedVersion)
    },

    async delete(vault, collection, id) {
      db.prepare(`DELETE FROM ${tableName} WHERE vault = ? AND collection = ? AND id = ?`)
        .run(vault, collection, id)
    },

    async list(vault, collection) {
      const rows = db
        .prepare(`SELECT id FROM ${tableName} WHERE vault = ? AND collection = ? ORDER BY id`)
        .all(vault, collection) as Array<{ id: string }>
      return rows.map(r => r.id)
    },

    async loadAll(vault) {
      const rows = db
        .prepare(`SELECT * FROM ${tableName} WHERE vault = ?`)
        .all(vault) as Row[]
      const snap: VaultSnapshot = {}
      for (const row of rows) {
        // Internal collections (`_keyring`, `_sync`) are the vault's own
        // bookkeeping and must not appear in a snapshot — required by the store
        // contract, with `@noy-db/to-file` setting the reference behaviour via
        // the same `_`-prefix rule.
        if (row.collection.startsWith('_')) continue
        const bucket = snap[row.collection] ?? (snap[row.collection] = {})
        bucket[row.id] = rowToEnvelope(row)
      }
      return snap
    },

    async saveAll(vault, data) {
      db.exec('BEGIN IMMEDIATE')
      try {
        db.prepare(`DELETE FROM ${tableName} WHERE vault = ?`).run(vault)
        for (const [collection, recs] of Object.entries(data)) {
          for (const [id, envelope] of Object.entries(recs)) {
            upsert(vault, collection, id, envelope)
          }
        }
        db.exec('COMMIT')
      } catch (err) {
        db.exec('ROLLBACK')
        throw err
      }
    },

    async ping() {
      try {
        db.prepare('SELECT 1').get()
        return true
      } catch {
        return false
      }
    },

    async listPage(vault, collection, cursor, limit = 100) {
      const offset = cursor ? Number.parseInt(cursor, 10) : 0
      if (Number.isNaN(offset)) throw new Error(`Invalid cursor: ${cursor}`)

      const rows = db
        .prepare(
          `SELECT id, v, ts, env, iv, data, by, tier, elevated_by, det FROM ${tableName}
           WHERE vault = ? AND collection = ?
           ORDER BY id LIMIT ? OFFSET ?`,
        )
        .all(vault, collection, limit, offset) as Array<Row & { id: string }>

      const items = rows.map(r => ({
        id: r.id,
        envelope: rowToEnvelope({ ...r, vault, collection }),
      }))
      const result: ListPageResult = {
        items,
        nextCursor: rows.length < limit ? null : String(offset + limit),
      }
      return result
    },

    async tx(ops: readonly TxOp[]) {
      db.exec('BEGIN IMMEDIATE')
      try {
        for (const op of ops) {
          if (op.type === 'put') {
            if (!op.envelope) throw new Error(`tx put op missing envelope for ${op.id}`)
            upsert(op.vault, op.collection, op.id, op.envelope, op.expectedVersion)
          } else {
            if (op.expectedVersion !== undefined) {
              const existing = db
                .prepare(`SELECT v FROM ${tableName} WHERE vault = ? AND collection = ? AND id = ?`)
                .get(op.vault, op.collection, op.id) as { v: number } | undefined
              if (existing && existing.v !== op.expectedVersion) {
                throw new ConflictError(existing.v)
              }
            }
            db.prepare(`DELETE FROM ${tableName} WHERE vault = ? AND collection = ? AND id = ?`)
              .run(op.vault, op.collection, op.id)
          }
        }
        db.exec('COMMIT')
      } catch (err) {
        db.exec('ROLLBACK')
        throw err
      }
    },
  }

  return store
}

// ─── Store-locator descriptor (#58 — `local` class, opaque-client tier) ──

/**
 * Serializable location of a SQLite store. `file` is identity-only — the
 * connection lives in the injected `binding.client`, so the factory does
 * not consume it.
 */
export interface SqliteAddress {
  /** Identity-only: not consumed by the factory (the connection carries it). */
  readonly file?: string
  /** Maps to `SqliteStoreOptions.tableName`. Default `'noydb_envelopes'` when omitted. */
  readonly table?: string
}

/** Serializable tuning carried on the descriptor (never credentials). */
export interface SqliteDescriptorOptions {
  readonly autoMigrate?: boolean
}

/**
 * Device-local supplement resolved at `resolve()` time — the live
 * `SqliteDatabase` this store has no way to construct itself. Never
 * serialized into a pod alongside the descriptor.
 */
export interface SqliteBinding {
  readonly client: SqliteDatabase
}

/**
 * Builds the `StoreDescriptor` form of a `toSqlite()` store:
 * `kind: 'sqlite'`, `class: 'local'`, with the identity address and the
 * serializable tuning as `options`. Credentialless by construction — the
 * live connection arrives via `binding.client` at `resolve()` time.
 */
export function sqliteStoreDescriptor(address: SqliteAddress, options?: SqliteDescriptorOptions): StoreDescriptor {
  return { kind: 'sqlite', class: 'local', address, ...(options !== undefined && { options }) }
}

/**
 * `StoreFactory` for `to-sqlite`: reconstructs the same store `toSqlite()`
 * builds, from a descriptor produced by {@link sqliteStoreDescriptor}.
 * `opts.binding.client` is required — this store has no client library of
 * its own and cannot build a connection from `address` alone.
 */
export const sqliteStoreFactory: StoreFactory = (descriptor, opts) => {
  const address = descriptor.address as SqliteAddress
  const { autoMigrate } = (descriptor.options ?? {}) as SqliteDescriptorOptions
  const binding = (opts.binding ?? {}) as Partial<SqliteBinding>
  if (!binding.client) {
    throw new Error(
      '@noy-db/to-sqlite: resolving this descriptor requires `binding.client` — ' +
      'this store does not construct its own connection. ' +
      'Pass one: locator.resolve(descriptor, { binding: { client } }).',
    )
  }
  return toSqlite({
    ...(autoMigrate !== undefined && { autoMigrate }),
    ...(address.table !== undefined && { tableName: address.table }),
    db: binding.client,
  })
}

/** Registers {@link sqliteStoreFactory} under the `'sqlite'` kind on `locator`. */
export function registerSqliteStore(locator: StoreLocator): void {
  locator.register('sqlite', sqliteStoreFactory)
}
