/**
 * Shared store-contract conformance (#19 / #26).
 *
 * `toDrive()` returns a `NoydbPodStore` — whole-file blob I/O with OCC, not the
 * six-method KV contract — so it reaches the contract through the hub's
 * `wrapPodStore()`. The suite therefore exercises the wrapper as much as this
 * store, which is exactly how noy-db#908 was found: both pod stores failed
 * inside the wrapper, not in their own code. Fixed in @noy-db/hub 0.4.0-pre.11.
 */
import { wrapPodStore } from '@noy-db/hub/pod'
import { runStoreConformanceTests } from '@noy-db/test-adapter-conformance'
import { toDrive } from '../src/index.js'
import { mockDrive } from './_mock.js'

runStoreConformanceTests('to-drive (via wrapPodStore)', async () =>
  wrapPodStore(toDrive({ drive: mockDrive() })),
)
