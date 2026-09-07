/**
 * Shared store-contract conformance (noy-db-to#26), over the extracted
 * in-memory mysql2-style mock (`_mock.ts`).
 */
import { runStoreConformanceTests } from '@noy-db/test-adapter-conformance'
import { toMysql } from '../src/index.js'
import { mockClient } from './_mock.js'

runStoreConformanceTests('to-mysql (in-memory mysql2 mock)', async () =>
  toMysql({ client: mockClient() }),
)
