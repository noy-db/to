import { runStoreConformanceTests } from '@noy-db/test-adapter-conformance'
import { fakeRoot } from './fake-fs.js'
import { toBrowserFs } from '../src/index.js'

// A fresh in-memory volume per factory call — CI has no Chrome and no
// mounted share, so the File System Access surface is faked.
runStoreConformanceTests('store-browser-fs', async () => toBrowserFs({ handle: fakeRoot() }))
