/**
 * Shared store-contract conformance (noy-db-to#19).
 *
 * Runs against a REAL SQLite engine (`node:sqlite`, in-memory), not a mock, so
 * this is the strongest conformance signal in the repo — a mock can only fail
 * the ways its author anticipated.
 *
 * A fresh `:memory:` database per case: `DatabaseSync(':memory:')` is scoped to
 * its handle, so a new handle IS the isolation, and there is nothing to tear
 * down between cases.
 */
import { DatabaseSync } from 'node:sqlite'
import { runStoreConformanceTests } from '@noy-db/test-adapter-conformance'
import { toSqlite } from '../src/index.js'

runStoreConformanceTests('to-sqlite (node:sqlite, in-memory)', async () =>
  toSqlite({ db: new DatabaseSync(':memory:') }),
)
