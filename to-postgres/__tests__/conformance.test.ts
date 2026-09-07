/**
 * Shared store-contract conformance (noy-db-to#26), over the extracted
 * in-memory pg mock (`_mock.ts`) — the same fake the per-package suite
 * uses, so both test layers exercise one client definition.
 */
import { runStoreConformanceTests } from '@noy-db/test-adapter-conformance'
import { toPostgres } from '../src/index.js'
import { mockClient } from './_mock.js'

runStoreConformanceTests('to-postgres (in-memory pg mock)', async () =>
  toPostgres({ client: mockClient() }),
)
