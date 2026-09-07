/**
 * Shared store-contract conformance (noy-db-to#26), over the in-memory
 * WebDAV server fake (`_fake-dav.ts`) — PROPFIND multi-status listings with
 * percent-encoded hrefs, which is where the id/collection round-trip lives.
 */
import { runStoreConformanceTests } from '@noy-db/test-adapter-conformance'
import { toWebdav } from '../src/index.js'
import { fakeDav } from './_fake-dav.js'

runStoreConformanceTests('to-webdav (in-memory DAV fake)', async () =>
  toWebdav({ baseUrl: 'https://dav.example.com', fetch: fakeDav().fetch }),
)
