/**
 * **@noy-db/to-cloudflare-r2** — Cloudflare R2 adapter for noy-db.
 *
 * R2 is S3-API-compatible, so this package is a thin factory that
 * configures `@noy-db/to-aws-s3` to point at the R2 endpoint and
 * pass the R2-specific access key signature. Inherits all capabilities
 * from `toAwsS3()` — `casAtomic: true`, `serverWriteTime: true`, server-clock
 * sampling via `LastModified`, and `IfMatch`/`IfNoneMatch` conditional CAS.
 *
 * ## Why R2 for noy-db?
 *
 * - **Zero egress fees** — backup/archive workflows that stream the
 *   whole vault on a schedule cost nothing to read back.
 * - **S3-compatible** — no new API surface; same SDK, same commands.
 * - **Workers edge** — pair with `@noy-db/to-cloudflare-d1` for a
 *   pure-edge noy-db deployment.
 *
 * ## Account-id vs endpoint
 *
 * The simplest configuration passes your Cloudflare account id and
 * the bucket name:
 *
 * ```ts
 * import { toCloudflareR2 } from '@noy-db/to-cloudflare-r2'
 *
 * const store = toCloudflareR2({
 *   accountId: 'abc123…',       // Cloudflare dashboard → R2 → account id
 *   bucket: 'my-noydb-bucket',
 *   credentials: async () => ({
 *     kind: 'aws',
 *     accessKeyId: process.env.R2_ACCESS_KEY_ID!,
 *     secretAccessKey: process.env.R2_SECRET!,
 *   }),
 * })
 * ```
 *
 * Consumers who already have a configured `S3Client` (common in Workers
 * / multi-region setups) can pass it via `client`; the rest of the
 * options are ignored.
 *
 * @packageDocumentation
 */

import type {
  NoydbStore,
  StoreCredentialSource,
  StoreDescriptor,
  StoreFactory,
  StoreLocator,
} from '@noy-db/hub/to'
import type { S3Client, S3ClientConfig } from '@aws-sdk/client-s3'
import { S3Client as RealS3Client } from '@aws-sdk/client-s3'
import { toAwsS3, mapAws } from '@noy-db/to-aws-s3'

export interface R2Options {
  /** Cloudflare account id (from the R2 dashboard). Required unless `client` is supplied. */
  readonly accountId?: string
  /** R2 bucket name. */
  readonly bucket: string
  /** Key prefix within the bucket. Default `''`. */
  readonly prefix?: string
  /**
   * Rolling short-lived credentials source (the hub's #479 credential-broker
   * seam). R2 keys are S3-compatible, so the provider must yield
   * `kind: 'aws'` credentials; the SDK re-invokes it near `expiresAt`.
   * Ignored when `client` is supplied (a pre-built client always wins).
   */
  readonly credentials?: StoreCredentialSource
  /**
   * Pre-built S3Client — overrides every other authentication option.
   * Use this when you already share an R2-pointed client across adapters
   * or run in Cloudflare Workers with an injected binding.
   */
  readonly client?: S3Client
  /** Override the endpoint. Default derived from `accountId`. */
  readonly endpoint?: string
  /** Clock uncertainty bound for serverWriteTime (ms). Forwarded to toAwsS3(). Default: 5000. */
  clockUncertaintyMs?: number
}

const R2_REGION = 'auto'

/**
 * Build the default R2 endpoint URL for a Cloudflare account.
 * The public form is documented as:
 *   `https://<accountId>.r2.cloudflarestorage.com`
 */
export function r2EndpointFor(accountId: string): string {
  return `https://${accountId}.r2.cloudflarestorage.com`
}

/**
 * Create a noy-db store backed by Cloudflare R2. Delegates to
 * `@noy-db/to-aws-s3`'s `toAwsS3()` with R2-specific endpoint + region
 * configured.
 */
export function toCloudflareR2(options: R2Options): NoydbStore {
  if (options.client) {
    const opts: Parameters<typeof toAwsS3>[0] = {
      bucket: options.bucket,
      ...(options.prefix !== undefined && { prefix: options.prefix }),
      client: options.client,
      ...(options.clockUncertaintyMs !== undefined && { clockUncertaintyMs: options.clockUncertaintyMs }),
    }
    return {
      ...toAwsS3(opts),
      name: 'cloudflare-r2',
      capabilities: {
        casAtomic: true,
        serverWriteTime: true,
        auth: { kind: 'api-key', required: true, flow: 'static' },
      },
    }
  }

  if (!options.accountId) {
    throw new Error('@noy-db/to-cloudflare-r2: provide either `client` or `accountId`.')
  }
  if (!options.credentials) {
    throw new Error(
      '@noy-db/to-cloudflare-r2: authentication requires a `credentials` source or a pre-built `client`. ' +
        'Static keys are no longer accepted — wrap them: `credentials: async () => ({ kind: "aws", accessKeyId, secretAccessKey })`.',
    )
  }

  const endpoint = options.endpoint ?? r2EndpointFor(options.accountId)
  const config: S3ClientConfig = {
    region: R2_REGION,
    endpoint,
    credentials: async () => mapAws(await options.credentials!()),
    forcePathStyle: true,
  }
  const built = new RealS3Client(config)
  const opts: Parameters<typeof toAwsS3>[0] = {
    bucket: options.bucket,
    ...(options.prefix !== undefined && { prefix: options.prefix }),
    client: built,
    ...(options.clockUncertaintyMs !== undefined && { clockUncertaintyMs: options.clockUncertaintyMs }),
  }
  return {
    ...toAwsS3(opts),
    name: 'cloudflare-r2',
    capabilities: {
      casAtomic: true,
      serverWriteTime: true,
      auth: { kind: 'api-key', required: true, flow: 'static' },
    },
  }
}

// ─── Store-locator descriptor (#58 — `cloud` class) ──────────────────

/**
 * Serializable location of an R2 store. `endpoint` is location, not
 * tuning: it selects which server the store talks to, so it belongs on
 * the address rather than in `options`.
 */
export interface R2Address {
  readonly bucket: string
  readonly accountId?: string
  readonly prefix?: string
  /**
   * Overrides the derived `https://<accountId>.r2.cloudflarestorage.com`
   * origin (a custom domain, or an R2-compatible test endpoint).
   * `accountId` is still required alongside it — `resolve()` rejects a
   * descriptor carrying neither a `binding.client` nor an `accountId`,
   * whatever `endpoint` says.
   */
  readonly endpoint?: string
}

/** Serializable tuning carried on the descriptor (never credentials). */
export interface R2DescriptorOptions {
  readonly clockUncertaintyMs?: number
}

/**
 * Device-local supplement resolved at `resolve()` time — a pre-built
 * `S3Client` (a shared R2-pointed client, a Workers binding, or a test
 * fake). Never serialized into a pod alongside the descriptor. This is
 * `to-cloudflare-r2`'s binding-slot citizen (#58) — when supplied, it
 * always wins over address-derived construction.
 */
export interface R2Binding {
  readonly client?: S3Client
}

/**
 * Builds the `StoreDescriptor` form of a `toCloudflareR2()` store:
 * `kind: 'cloudflare-r2'`, `class: 'cloud'`. Credentialless by
 * construction — R2 keys are S3-compatible, so credentials arrive via a
 * `StoreCredentialSource` yielding `kind: 'aws'` at `resolve()` time.
 */
export function r2StoreDescriptor(address: R2Address, options?: R2DescriptorOptions): StoreDescriptor {
  return { kind: 'cloudflare-r2', class: 'cloud', address, ...(options !== undefined && { options }) }
}

/**
 * `StoreFactory` for `to-cloudflare-r2`: reconstructs the same store
 * `toCloudflareR2()` builds, from a descriptor produced by
 * {@link r2StoreDescriptor}. `opts.binding` may carry a pre-built client
 * ({@link R2Binding}), which always wins over `accountId` + credentials.
 */
export const r2StoreFactory: StoreFactory = (descriptor, opts) => {
  const { bucket, accountId, prefix, endpoint } = descriptor.address as R2Address
  const { clockUncertaintyMs } = (descriptor.options ?? {}) as R2DescriptorOptions
  const binding = (opts.binding ?? {}) as R2Binding
  return toCloudflareR2({
    bucket,
    ...(accountId !== undefined && { accountId }),
    ...(prefix !== undefined && { prefix }),
    ...(endpoint !== undefined && { endpoint }),
    ...(clockUncertaintyMs !== undefined && { clockUncertaintyMs }),
    ...(opts.credentials !== undefined && { credentials: opts.credentials }),
    ...(binding.client !== undefined && { client: binding.client }),
  })
}

/** Registers {@link r2StoreFactory} under the `'cloudflare-r2'` kind on `locator`. */
export function registerR2Store(locator: StoreLocator): void {
  locator.register('cloudflare-r2', r2StoreFactory)
}
