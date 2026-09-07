import type { StoreCredentials } from '@noy-db/hub/to'

/**
 * Minimal AWS credential identity shape (mirrors `@aws-sdk/types`'
 * `AwsCredentialIdentity`; not imported from there to avoid a new
 * dependency — `@aws-sdk/types` is only a transitive dep here).
 */
export interface AwsCredentialIdentityLike {
  accessKeyId: string
  secretAccessKey: string
  sessionToken?: string
  expiration?: Date
}

/**
 * Maps a broker-issued `StoreCredentials` to the shape the AWS SDK v3
 * credential provider expects. Shared by both S3Client construction sites
 * in this package (`toAwsS3()` and `s3Bundle()`). Conditional-spread for both
 * optional fields: `exactOptionalPropertyTypes` forbids `expiration:
 * undefined`, and the SDK's credential memoizer treats an *absent*
 * `expiration` as "unknown, never re-invoke" vs. a present `Date` as
 * "re-invoke at the rolling window".
 */
export function mapAws(creds: StoreCredentials): AwsCredentialIdentityLike {
  if (creds.kind !== 'aws') {
    throw new Error(`to-aws-s3: credentials hook returned kind '${creds.kind}', expected 'aws'`)
  }
  return {
    accessKeyId: creds.accessKeyId,
    secretAccessKey: creds.secretAccessKey,
    ...(creds.sessionToken ? { sessionToken: creds.sessionToken } : {}),
    ...(creds.expiresAt ? { expiration: new Date(creds.expiresAt) } : {}),
  }
}
