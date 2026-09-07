/**
 * **@noy-db/to-cloudflare-d1** — Cloudflare D1 adapter for noy-db.
 *
 * D1 is Cloudflare's edge SQLite. Inside a Worker, the `env.DB` binding
 * exposes a `D1Database` whose API is `prepare(sql).bind(...args).run()`
 * — different from node-postgres or libSQL but easy to adapt.
 *
 * ```ts
 * import { toCloudflareD1 } from '@noy-db/to-cloudflare-d1'
 *
 * export default {
 *   async fetch(request: Request, env: { DB: D1Database }) {
 *     const store = toCloudflareD1({ db: env.DB })
 *     const db = await createNoydb({ store })
 *     // …
 *   },
 * }
 * ```
 *
 * ## Capabilities
 *
 * | Capability  | Value |
 * |-------------|-------|
 * | `casAtomic` | `true` — `UPDATE … WHERE v = ?` inside a D1 batch |
 * | `txAtomic`  | `true` — `D1Database.batch()` is atomic per-session; per-op `expectedVersion` enforced by in-batch guards |
 * | `listPage`  | ✓ — keyset pagination by id |
 * | `ping`      | ✓ — `SELECT 1` |
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

/** Duck-typed subset of the `D1Database` binding. */
export interface D1Database {
  prepare(sql: string): D1PreparedStatement
  batch<T = unknown>(statements: readonly D1PreparedStatement[]): Promise<D1Result<T>[]>
  exec?(sql: string): Promise<unknown>
}

export interface D1PreparedStatement {
  bind(...args: readonly unknown[]): D1PreparedStatement
  first<T = unknown>(): Promise<T | null>
  all<T = unknown>(): Promise<D1Result<T>>
  run<T = unknown>(): Promise<D1Result<T>>
}

export interface D1Result<T = unknown> {
  readonly results?: readonly T[]
  readonly success?: boolean
}

export interface D1StoreOptions {
  readonly db: D1Database
  readonly tableName?: string
  readonly autoMigrate?: boolean
}

export function toCloudflareD1(options: D1StoreOptions): NoydbStore {
  const { db, tableName = 'noydb_envelopes', autoMigrate = true } = options
  let schemaReady: Promise<void> | null = null

  async function ensureSchema(): Promise<void> {
    if (!autoMigrate) return
    if (!schemaReady) {
      schemaReady = (async () => {
        // New writes only populate vault/collection/id/v/ts/env — `env` is
        // `JSON.stringify(envelope)`, the ENTIRE envelope, so no field (including
        // ones this store doesn't know about, e.g. `_cek`/`_debug`) is ever
        // silently dropped. `v`/`ts` stay as real columns because CAS (`WHERE
        // v = ?`) and ordering need to query them without deserializing `env`.
        // iv/data are still written on every upsert (see `upsertStatement`) so
        // the NOT NULL constraint keeps holding on tables created before this
        // migration; by/tier/elevated_by/det/del are LEGACY columns, kept
        // nullable for dual-read of rows written before this migration (see
        // `rowToEnvelope`) — no data migration script required (pre-1.0).
        await db
          .prepare(
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
          .run()
        // `CREATE TABLE IF NOT EXISTS` is a no-op against a table that
        // already exists from before this migration — it has no `env`
        // column, so every write/read would fail otherwise. `ALTER TABLE
        // ADD COLUMN` backfills it; on a table just created fresh above
        // (env already in the DDL) this throws "duplicate column name",
        // swallowed as the expected no-op. Anything else rethrows.
        try {
          await db.prepare(`ALTER TABLE ${tableName} ADD COLUMN env TEXT`).run()
        } catch (err) {
          if (!(err instanceof Error) || !err.message.toLowerCase().includes('duplicate column name')) throw err
        }
        await db
          .prepare(`CREATE INDEX IF NOT EXISTS idx_${tableName}_vc ON ${tableName} (vault, collection)`)
          .run()
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
    const del = row.del as number | null
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
      ...(del === 1 && { _del: true as const }),
    }
  }

  function upsertStatement(
    vault: string,
    collection: string,
    id: string,
    envelope: EncryptedEnvelope,
  ): D1PreparedStatement {
    return db
      .prepare(
        `INSERT INTO ${tableName} (vault, collection, id, v, ts, env, iv, data)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(vault, collection, id) DO UPDATE SET
           v = excluded.v, ts = excluded.ts, env = excluded.env, iv = excluded.iv, data = excluded.data`,
      )
      .bind(vault, collection, id, envelope._v, envelope._ts, JSON.stringify(envelope), envelope._iv, envelope._data)
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
      const existing = await db
        .prepare(`SELECT v FROM ${tableName} WHERE vault = ? AND collection = ? AND id = ?`)
        .bind(vault, collection, id)
        .first<{ v: number }>()
      if (existing && existing.v !== expectedVersion) {
        throw new ConflictError(existing.v, `Version conflict: expected ${expectedVersion}, found ${existing.v}`)
      }
    }
    await upsertStatement(vault, collection, id, envelope).run()
  }

  const store: NoydbStore = {
    name: 'cloudflare-d1',
    capabilities: {
      casAtomic: true,
      txAtomic: true,
      auth: { kind: 'api-key', required: true, flow: 'static' },
    },

    async get(vault, collection, id) {
      await ensureSchema()
      const row = await db
        .prepare(`SELECT * FROM ${tableName} WHERE vault = ? AND collection = ? AND id = ?`)
        .bind(vault, collection, id)
        .first<Record<string, unknown>>()
      return row ? rowToEnvelope(row) : null
    },

    async put(vault, collection, id, envelope, expectedVersion) {
      await upsert(vault, collection, id, envelope, expectedVersion)
    },

    async delete(vault, collection, id) {
      await ensureSchema()
      await db
        .prepare(`DELETE FROM ${tableName} WHERE vault = ? AND collection = ? AND id = ?`)
        .bind(vault, collection, id)
        .run()
    },

    async list(vault, collection) {
      await ensureSchema()
      const res = await db
        .prepare(`SELECT id FROM ${tableName} WHERE vault = ? AND collection = ? ORDER BY id`)
        .bind(vault, collection)
        .all<{ id: string }>()
      return (res.results ?? []).map(r => r.id)
    },

    async loadAll(vault) {
      await ensureSchema()
      const res = await db
        .prepare(`SELECT * FROM ${tableName} WHERE vault = ?`)
        .bind(vault)
        .all<Record<string, unknown>>()
      const snap: VaultSnapshot = {}
      for (const row of res.results ?? []) {
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
      const statements: D1PreparedStatement[] = [
        db.prepare(`DELETE FROM ${tableName} WHERE vault = ?`).bind(vault),
      ]
      for (const [collection, recs] of Object.entries(data)) {
        for (const [id, envelope] of Object.entries(recs)) {
          statements.push(upsertStatement(vault, collection, id, envelope))
        }
      }
      await db.batch(statements)
    },

    async ping() {
      try {
        await db.prepare('SELECT 1').run()
        return true
      } catch {
        return false
      }
    },

    async listPage(vault, collection, cursor, limit = 100) {
      await ensureSchema()
      const afterId = cursor ?? ''
      const res = await db
        .prepare(
          `SELECT id, v, ts, env, iv, data, by, tier, elevated_by, det FROM ${tableName}
           WHERE vault = ? AND collection = ? AND id > ?
           ORDER BY id LIMIT ?`,
        )
        .bind(vault, collection, afterId, limit + 1)
        .all<Record<string, unknown>>()
      const rows = res.results ?? []
      const hasMore = rows.length > limit
      const trimmed = hasMore ? rows.slice(0, limit) : rows
      const items = trimmed.map(r => ({ id: r.id as string, envelope: rowToEnvelope(r) }))
      const out: ListPageResult = {
        items,
        nextCursor: hasMore ? (trimmed[trimmed.length - 1]!.id as string) : null,
      }
      return out
    },

    async tx(ops: readonly TxOp[]) {
      await ensureSchema()
      // Guards run FIRST, inside the same atomic batch as the writes: a
      // conditional UPDATE that matches zero rows cannot abort a D1 batch,
      // so each expectedVersion becomes a statement that RAISES (NOT NULL
      // violation on `v`) exactly when its precondition fails against the
      // pre-batch state — aborting and rolling back the entire batch.
      //   expectedVersion 0  → row must NOT exist (create-only)
      //   expectedVersion N  → row must exist at exactly v = N
      const guarded = ops.filter(op => op.expectedVersion !== undefined)
      const statements: D1PreparedStatement[] = []
      for (const op of guarded) {
        const clause = op.expectedVersion === 0
          ? `EXISTS (SELECT 1 FROM ${tableName} WHERE vault = ? AND collection = ? AND id = ?)`
          : `NOT EXISTS (SELECT 1 FROM ${tableName} WHERE vault = ? AND collection = ? AND id = ? AND v = ?)`
        const args = op.expectedVersion === 0
          ? [op.vault, op.collection, op.id]
          : [op.vault, op.collection, op.id, op.expectedVersion]
        statements.push(
          db
            .prepare(
              `INSERT INTO ${tableName} (vault, collection, id, v, ts, iv, data)
               SELECT '', '', '', NULL, '', '', '' WHERE ${clause}`,
            )
            .bind(...args),
        )
      }
      for (const op of ops) {
        if (op.type === 'put') {
          if (!op.envelope) throw new Error(`tx put op missing envelope for ${op.id}`)
          statements.push(upsertStatement(op.vault, op.collection, op.id, op.envelope))
        } else {
          statements.push(
            db
              .prepare(`DELETE FROM ${tableName} WHERE vault = ? AND collection = ? AND id = ?`)
              .bind(op.vault, op.collection, op.id),
          )
        }
      }
      try {
        await db.batch(statements)
      } catch (err) {
        // The batch rolled back. Re-probe each guarded op against the
        // (restored) pre-batch state; a mismatch identifies the tripped
        // guard → ConflictError. No mismatch found (e.g. an unrelated SQL
        // error) → rethrow the original.
        for (const op of guarded) {
          const row = await db
            .prepare(`SELECT v FROM ${tableName} WHERE vault = ? AND collection = ? AND id = ?`)
            .bind(op.vault, op.collection, op.id)
            .first<{ v: number }>()
          const conflicted = op.expectedVersion === 0 ? row !== null : row?.v !== op.expectedVersion
          if (conflicted) {
            throw new ConflictError(
              row?.v ?? 0,
              `tx version conflict on ${op.collection}/${op.id}: expected ${op.expectedVersion}, found ${row?.v ?? 'no row'}`,
            )
          }
        }
        throw err
      }
    },
  }

  return store
}

// ─── Store-locator descriptor (#58 — `cloud` class, opaque-client tier) ──

/**
 * Serializable location of a Cloudflare D1 store. `binding` and `database`
 * are identity-only — the connection lives in the injected
 * `binding.client`, so the factory does not consume them.
 */
export interface CloudflareD1Address {
  /**
   * The Workers `env.<BINDING>` name — how a D1 user identifies a
   * database. Note the unfortunate collision with our own `binding` slot
   * on {@link CloudflareD1Binding} — this field names the D1 binding, not
   * our locator's binding. Identity-only: not consumed by the factory.
   */
  readonly binding?: string
  /** Identity-only: not consumed by the factory (the connection carries it). */
  readonly database?: string
  /** Maps to `D1StoreOptions.tableName`. Default `'noydb_envelopes'` when omitted. */
  readonly table?: string
}

/** Serializable tuning carried on the descriptor (never credentials). */
export interface CloudflareD1DescriptorOptions {
  readonly autoMigrate?: boolean
}

/**
 * Device-local supplement resolved at `resolve()` time — the live
 * `D1Database` this store has no way to construct itself. Never serialized
 * into a pod alongside the descriptor.
 */
export interface CloudflareD1Binding {
  readonly client: D1Database
}

/**
 * Builds the `StoreDescriptor` form of a `toCloudflareD1()` store:
 * `kind: 'cloudflare-d1'`, `class: 'cloud'`, with the identity address and
 * the serializable tuning as `options`. Credentialless by construction —
 * the live connection arrives via `binding.client` at `resolve()` time.
 */
export function cloudflareD1StoreDescriptor(
  address: CloudflareD1Address,
  options?: CloudflareD1DescriptorOptions,
): StoreDescriptor {
  return { kind: 'cloudflare-d1', class: 'cloud', address, ...(options !== undefined && { options }) }
}

/**
 * `StoreFactory` for `to-cloudflare-d1`: reconstructs the same store
 * `toCloudflareD1()` builds, from a descriptor produced by
 * {@link cloudflareD1StoreDescriptor}. `opts.binding.client` is required —
 * this store has no client library of its own and cannot build a
 * connection from `address` alone.
 */
export const cloudflareD1StoreFactory: StoreFactory = (descriptor, opts) => {
  const address = descriptor.address as CloudflareD1Address
  const { autoMigrate } = (descriptor.options ?? {}) as CloudflareD1DescriptorOptions
  const binding = (opts.binding ?? {}) as Partial<CloudflareD1Binding>
  if (!binding.client) {
    throw new Error(
      '@noy-db/to-cloudflare-d1: resolving this descriptor requires `binding.client` — ' +
      'this store does not construct its own connection. ' +
      'Pass one: locator.resolve(descriptor, { binding: { client } }).',
    )
  }
  return toCloudflareD1({
    ...(autoMigrate !== undefined && { autoMigrate }),
    ...(address.table !== undefined && { tableName: address.table }),
    db: binding.client,
  })
}

/** Registers {@link cloudflareD1StoreFactory} under the `'cloudflare-d1'` kind on `locator`. */
export function registerCloudflareD1Store(locator: StoreLocator): void {
  locator.register('cloudflare-d1', cloudflareD1StoreFactory)
}
