/**
 * Shared store-contract conformance (noy-db-to#26), over the full in-memory
 * S3 fake (`_fake-s3.ts`) — conditional writes, sorted ListObjectsV2 with
 * continuation tokens, and server-assigned LastModified.
 */
import { runStoreConformanceTests } from '@noy-db/test-adapter-conformance'
import { toAwsS3 } from '../src/index.js'
import { fakeS3 } from './_fake-s3.js'

runStoreConformanceTests('to-aws-s3 (in-memory S3 fake)', async () =>
  toAwsS3({ bucket: 'conformance', client: fakeS3().client }),
)
