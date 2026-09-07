/**
 * Shared store-contract conformance (noy-db-to#26 pattern) for to-rest.
 *
 * Runs against a LIVE `createRestHandler` from the published
 * `@noy-db/in-rest` over an in-memory backing store — the suite crosses
 * the real wire contract (router dispatch, auth, error envelopes) on
 * every call, not a mock interpretation of it.
 */
import { runStoreConformanceTests } from '@noy-db/test-adapter-conformance'
import { toRest } from '../src/index.js'
import { restHarness } from './_harness.js'

runStoreConformanceTests('to-rest (live in-rest handler over memory fixture)', async () =>
  toRest({
    baseUrl: 'https://vault.example.com',
    headers: { authorization: 'Bearer test-key' },
    fetch: restHarness().fetch,
  }),
)
