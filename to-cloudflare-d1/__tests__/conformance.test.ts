/**
 * Shared store-contract conformance (noy-db-to#26).
 *
 * Runs against a REAL SQLite engine: D1 *is* SQLite at the edge, so wrapping
 * `node:sqlite` (in-memory) in the `D1Database` duck shape exercises the
 * store's actual SQL (RETURNING, ON CONFLICT upserts, batch) on the same
 * engine family it targets in production — no mock interpretation layer.
 *
 * `batch()` runs its statements inside BEGIN…COMMIT, matching D1's
 * atomic-per-batch semantics that back the store's `txAtomic` capability.
 */
import { runStoreConformanceTests } from '@noy-db/test-adapter-conformance'
import { toCloudflareD1 } from '../src/index.js'
import { d1OverNodeSqlite } from './_engine.js'

runStoreConformanceTests('to-cloudflare-d1 (node:sqlite via D1Database shape)', async () =>
  toCloudflareD1({ db: d1OverNodeSqlite() }),
)
