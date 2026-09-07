/**
 * **@noy-db/to-supabase** — Supabase adapter for noy-db.
 *
 * Supabase projects ship both a Postgres database and an S3-compatible
 * object store. This package is a thin factory that configures
 * `@noy-db/to-postgres` for the Postgres pool that the consumer has
 * already wired (via `@supabase/supabase-js`, node-postgres, or the
 * Supabase serverless driver) and re-exports the result.
 *
 * ## Why not embed `@supabase/supabase-js`?
 *
 * The Supabase client is a large dependency that also bundles
 * `node-fetch`, a realtime websocket, and a storage client. Embedding
 * it would duplicate transport code that the consumer has already
 * installed for their app logic. The noy-db adapter only needs the
 * Postgres query path, so we accept whatever SQL-capable client the
 * consumer passes in — same contract as `@noy-db/to-postgres`.
 *
 * ## Typical wiring
 *
 * ```ts
 * import { createClient } from '@supabase/supabase-js'
 * import { toSupabase } from '@noy-db/to-supabase'
 * import pg from 'pg'
 *
 * const pool = new pg.Pool({ connectionString: process.env.SUPABASE_DB_URL })
 * const store = toSupabase({ client: pool })
 *
 * // Optionally, the Supabase JS client for Storage-based blob routing:
 * const s = createClient(url, key)
 * // … blob-routing helpers can be added in a follow-up
 * ```
 *
 * ## Capabilities
 *
 * Inherits everything from `@noy-db/to-postgres`: `casAtomic: true`,
 * `txAtomic: true`, `listPage`, `ping`.
 *
 * @packageDocumentation
 */

import type { NoydbStore, StoreDescriptor, StoreFactory, StoreLocator } from '@noy-db/hub/to'
import type { PostgresClient, PostgresStoreOptions } from '@noy-db/to-postgres'
import { toPostgres } from '@noy-db/to-postgres'

export type { PostgresClient }

export interface SupabaseStoreOptions extends Omit<PostgresStoreOptions, 'client'> {
  /**
   * Any Postgres-compatible client — `pg.Pool`, `pg.Client`, or a
   * Supabase serverless driver. The noy-db store never talks to the
   * Supabase REST / Realtime APIs.
   */
  readonly client: PostgresClient
}

/**
 * Create a noy-db store backed by a Supabase Postgres connection.
 * Inherits the entire `@noy-db/to-postgres` feature set.
 */
export function toSupabase(options: SupabaseStoreOptions): NoydbStore {
  const base = toPostgres(options)
  return {
    ...base,
    name: 'supabase',
    capabilities: {
      casAtomic: true,
      txAtomic: true,
      auth: { kind: 'api-key', required: true, flow: 'static' },
    },
  }
}

// ─── Store-locator descriptor (#58 — `cloud` class, opaque-client tier) ──

/**
 * Serializable location of a Supabase-Postgres store. `projectRef` and
 * `schema` are identity-only — the connection lives in the injected
 * `binding.client`, so the factory does not consume them.
 */
export interface SupabaseAddress {
  /** Identity-only: not consumed by the factory (the connection carries it). */
  readonly projectRef?: string
  /** Identity-only: not consumed by the factory (the connection carries it). */
  readonly schema?: string
  /** Maps to `SupabaseStoreOptions.tableName`. Default `'noydb_envelopes'` when omitted. */
  readonly table?: string
}

/** Serializable tuning carried on the descriptor (never credentials). */
export interface SupabaseDescriptorOptions {
  readonly autoMigrate?: boolean
}

/**
 * Device-local supplement resolved at `resolve()` time — the live
 * `PostgresClient` this store has no way to construct itself. Never
 * serialized into a pod alongside the descriptor.
 */
export interface SupabaseBinding {
  readonly client: PostgresClient
}

/**
 * Builds the `StoreDescriptor` form of a `toSupabase()` store:
 * `kind: 'supabase'`, `class: 'cloud'`, with the identity address and the
 * serializable tuning as `options`. Credentialless by construction — the
 * live connection arrives via `binding.client` at `resolve()` time.
 */
export function supabaseStoreDescriptor(address: SupabaseAddress, options?: SupabaseDescriptorOptions): StoreDescriptor {
  return { kind: 'supabase', class: 'cloud', address, ...(options !== undefined && { options }) }
}

/**
 * `StoreFactory` for `to-supabase`: reconstructs the same store
 * `toSupabase()` builds, from a descriptor produced by
 * {@link supabaseStoreDescriptor}. `opts.binding.client` is required —
 * this store has no client library of its own and cannot build a
 * connection from `address` alone.
 */
export const supabaseStoreFactory: StoreFactory = (descriptor, opts) => {
  const address = descriptor.address as SupabaseAddress
  const { autoMigrate } = (descriptor.options ?? {}) as SupabaseDescriptorOptions
  const binding = (opts.binding ?? {}) as Partial<SupabaseBinding>
  if (!binding.client) {
    throw new Error(
      '@noy-db/to-supabase: resolving this descriptor requires `binding.client` — ' +
      'this store does not construct its own connection. ' +
      'Pass one: locator.resolve(descriptor, { binding: { client } }).',
    )
  }
  return toSupabase({
    ...(autoMigrate !== undefined && { autoMigrate }),
    ...(address.table !== undefined && { tableName: address.table }),
    client: binding.client,
  })
}

/** Registers {@link supabaseStoreFactory} under the `'supabase'` kind on `locator`. */
export function registerSupabaseStore(locator: StoreLocator): void {
  locator.register('supabase', supabaseStoreFactory)
}
