/**
 * Shared store-contract conformance (noy-db-to#26), over the extracted
 * in-memory SFTP handle mock (`_mock.ts`).
 */
import { runStoreConformanceTests } from '@noy-db/test-adapter-conformance'
import { toSsh } from '../src/index.js'
import { mockSftp } from './_mock.js'

runStoreConformanceTests('to-ssh (in-memory SFTP handle mock)', async () =>
  toSsh({ sftp: mockSftp(), remotePath: 'noydb' }),
)
