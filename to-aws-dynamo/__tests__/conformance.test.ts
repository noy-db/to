/**
 * Shared store-contract conformance (noy-db-to#26), over the full in-memory
 * DynamoDB document-client fake (`_fake-dynamo.ts`): conditional puts and
 * sk-sorted Query pagination.
 */
import { runStoreConformanceTests } from '@noy-db/test-adapter-conformance'
import { toAwsDynamo } from '../src/index.js'
import { fakeDynamo } from './_fake-dynamo.js'

runStoreConformanceTests('to-aws-dynamo (in-memory document-client fake)', async () =>
  toAwsDynamo({ table: 'conformance', client: fakeDynamo().client }),
)
