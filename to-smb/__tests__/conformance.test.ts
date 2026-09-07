/**
 * Shared store-contract conformance (noy-db-to#26), over the extracted
 * in-memory SMB handle mock (`_mock.ts`).
 */
import { runStoreConformanceTests } from '@noy-db/test-adapter-conformance'
import { toSmb } from '../src/index.js'
import { mockSmb } from './_mock.js'

runStoreConformanceTests('to-smb (in-memory SMB handle mock)', async () =>
  toSmb({ smb: mockSmb() }),
)
