/**
 * Shared store-contract conformance (noy-db-to#26).
 *
 * Uses to-aws-s3's `_fake-s3.ts` through the `client` injection path — R2 is
 * S3-API-compatible and `toCloudflareR2()` delegates to `toAwsS3()`, so the
 * same fake exercises the real delegation (including the R2 capability
 * override staying contract-honest).
 */
import { runStoreConformanceTests } from '@noy-db/test-adapter-conformance'
import { toCloudflareR2 } from '../src/index.js'
import { fakeS3 } from '../../to-aws-s3/__tests__/_fake-s3.js'

runStoreConformanceTests('to-cloudflare-r2 (in-memory S3 fake via client injection)', async () =>
  toCloudflareR2({ bucket: 'conformance', client: fakeS3().client }),
)
