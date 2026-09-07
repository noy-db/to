/**
 * Shared store-contract conformance (#19 / #26).
 *
 * `toIcloud()` returns a `NoydbPodStore`, so it reaches the six-method contract
 * through the hub's `wrapPodStore()` — see the sibling note in to-drive. The
 * wrapper defects this surfaced are noy-db#908, fixed in @noy-db/hub
 * 0.4.0-pre.11.
 *
 * A fresh folder name per store keeps cases from sharing state through the
 * mock filesystem.
 */
import { wrapPodStore } from '@noy-db/hub/pod'
import { runStoreConformanceTests } from '@noy-db/test-adapter-conformance'
import { toIcloud } from '../src/index.js'
import { mockFs } from './_mock.js'

let seq = 0

runStoreConformanceTests('to-icloud (via wrapPodStore)', async () =>
  wrapPodStore(toIcloud({ folder: `/icloud-conformance-${++seq}`, fs: mockFs() })),
)
