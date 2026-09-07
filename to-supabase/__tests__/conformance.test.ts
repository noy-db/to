/**
 * Shared store-contract conformance (noy-db-to#26).
 *
 * Uses to-postgres's extracted `_mock.ts` deliberately: `toSupabase()`
 * delegates everything to `toPostgres()` over the same client contract, so
 * conforming against the full pg mock exercises the real delegation path
 * (the package's own minimal inline mock covers only its focused tests).
 */
import { runStoreConformanceTests } from '@noy-db/test-adapter-conformance'
import { toSupabase } from '../src/index.js'
import { mockClient } from '../../to-postgres/__tests__/_mock.js'

runStoreConformanceTests('to-supabase (delegating to postgres, in-memory pg mock)', async () =>
  toSupabase({ client: mockClient() }),
)
