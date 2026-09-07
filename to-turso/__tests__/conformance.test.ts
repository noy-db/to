/**
 * Shared store-contract conformance (noy-db-to#26).
 *
 * Runs against a REAL SQLite engine: `node:sqlite` (in-memory) wrapped in the
 * `LibsqlClient` duck shape — libSQL is a SQLite fork, so the SQL surface the
 * store emits (RETURNING, ON CONFLICT upserts, unixepoch) executes natively.
 * A mock can only fail the ways its author anticipated; this cannot.
 *
 * `batch()` wraps its statements in BEGIN…COMMIT, mirroring libSQL's implicit
 * one-transaction batch semantics — which is exactly the atomicity claim the
 * store's `txAtomic` capability makes (#22).
 */
import { runStoreConformanceTests } from '@noy-db/test-adapter-conformance'
import { toTurso } from '../src/index.js'
import { libsqlOverNodeSqlite } from './_engine.js'

runStoreConformanceTests('to-turso (node:sqlite via LibsqlClient shape)', async () =>
  toTurso({ client: libsqlOverNodeSqlite() }),
)
