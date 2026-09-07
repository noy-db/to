/**
 * **@noy-db/to-aws-dynamo** — DynamoDB single-table store for NOYDB.
 *
 * Uses a single DynamoDB table with a composite key:
 * - **`pk`** (partition key, String) — vault name.
 * - **`sk`** (sort key, String) — `{collection}#{id}`.
 *
 * This layout keeps every record of a vault in one partition, making
 * `loadAll()` a single `Query` call with no scatter-gather. Individual
 * reads and writes use `GetItem` / `PutItem` with optional
 * `ConditionExpression` for atomic compare-and-swap.
 *
 * ## When to use
 *
 * - **Cloud-synced vaults** — DynamoDB's per-item CAS
 *   (`casAtomic: true`) is safe under concurrent writes from multiple
 *   clients (multi-user, multi-tab).
 * - **Serverless / Lambda** — no connection pool to manage; each
 *   invocation opens fresh HTTP connections via the AWS SDK.
 * - **Pair with S3 for blobs** — keep structured records in DynamoDB
 *   and route binary attachments to `@noy-db/to-aws-s3` via `routeStore`.
 *
 * ## IAM minimum permissions
 *
 * ```json
 * { "Action": ["dynamodb:GetItem", "dynamodb:PutItem",
 *              "dynamodb:DeleteItem", "dynamodb:Query"] }
 * ```
 *
 * (`tx()` needs no extra action: `TransactWriteItems` authorizes against the
 * per-item `dynamodb:PutItem` / `dynamodb:DeleteItem` permissions above.)
 *
 * ## Capabilities
 *
 * | Capability | Value |
 * |---|---|
 * | `casAtomic` | `true` — DynamoDB `ConditionExpression` on `_v` |
 * | `txAtomic` | `true` — `TransactWriteItems` with per-item `ConditionExpression` on `_v`; ≤100 ops per batch (over-limit throws, never splits) |
 * | `ping` | ✓ — a `Query` on the reserved `__ping__` partition. NOT `DescribeTable`:
 *   a client scoped by `dynamodb:LeadingKeys` cannot read that partition, so
 *   `ping()` returns `false` against a healthy table. See README, #17. |
 *
 * @packageDocumentation
 */

import type {
  NoydbStore,
  EncryptedEnvelope,
  VaultSnapshot,
  StoreCredentials,
  StoreCredentialSource,
  TxOp,
  StoreDescriptor,
  StoreFactory,
  StoreLocator,
} from '@noy-db/hub/to'
import { ConflictError } from '@noy-db/hub/to'

/**
 * Options for `toAwsDynamo()`.
 *
 * The adapter uses a single-table design with a composite primary key
 * `pk = {vault}` (partition) and `sk = {collection}#{id}` (sort). This keeps
 * all records for a vault in a single DynamoDB partition for efficient
 * `loadAll()` via a single Query. For DynamoDB Local development, set
 * `endpoint: 'http://localhost:8000'`.
 */
export interface DynamoOptions {
  /** DynamoDB table name. */
  table: string
  /** AWS region. Default: 'us-east-1'. */
  region?: string
  /** Custom endpoint (e.g., 'http://localhost:8000' for DynamoDB Local). */
  endpoint?: string
  /** DynamoDB document client instance (for advanced configuration). */
  client?: DynamoDocClient
  /**
   * Refresh hook (the #479 credential broker) — called by the SDK's own
   * credential provider whenever it has no credentials or they're near
   * expiry. Ignored when `client` is supplied (a pre-built client always
   * wins).
   */
  credentials?: StoreCredentialSource
}

/**
 * Minimal AWS credential identity shape (mirrors `@aws-sdk/types`'
 * `AwsCredentialIdentity`; not imported from there to avoid a new
 * dependency — the SDK classes above are only ever dynamically imported).
 */
export interface AwsCredentialIdentityLike {
  accessKeyId: string
  secretAccessKey: string
  sessionToken?: string
  expiration?: Date
}

/**
 * Maps a broker-issued `StoreCredentials` to the shape the AWS SDK v3
 * credential provider expects. Conditional-spread for both optional fields:
 * `exactOptionalPropertyTypes` forbids `expiration: undefined`, and the SDK's
 * credential memoizer treats an *absent* `expiration` as "unknown, never
 * re-invoke" vs. a present `Date` as "re-invoke at the rolling window".
 */
export function mapAws(creds: StoreCredentials): AwsCredentialIdentityLike {
  if (creds.kind !== 'aws') {
    throw new Error(`to-aws-dynamo: credentials hook returned kind '${creds.kind}', expected 'aws'`)
  }
  return {
    accessKeyId: creds.accessKeyId,
    secretAccessKey: creds.secretAccessKey,
    ...(creds.sessionToken ? { sessionToken: creds.sessionToken } : {}),
    ...(creds.expiresAt ? { expiration: new Date(creds.expiresAt) } : {}),
  }
}

/**
 * Minimal interface for DynamoDB document client operations.
 * Compatible with @aws-sdk/lib-dynamodb's DynamoDBDocumentClient.
 */
export interface DynamoDocClient {
  send(command: unknown): Promise<unknown>
}

// Command types matching @aws-sdk/lib-dynamodb
interface GetCommandInput { TableName: string; Key: Record<string, unknown> }
interface PutCommandInput { TableName: string; Item: Record<string, unknown>; ConditionExpression?: string; ExpressionAttributeNames?: Record<string, string>; ExpressionAttributeValues?: Record<string, unknown> }
interface DeleteCommandInput { TableName: string; Key: Record<string, unknown> }
interface QueryCommandInput {
  TableName: string
  KeyConditionExpression: string
  ExpressionAttributeNames?: Record<string, string>
  ExpressionAttributeValues?: Record<string, unknown>
  Limit?: number
  ExclusiveStartKey?: Record<string, unknown>
}

/**
 * Create a DynamoDB adapter using single-table design.
 *
 * Table schema:
 * - pk (String, partition key): vault name
 * - sk (String, sort key): `{collection}#{id}` or `_keyring#{userId}` or `_sync#meta`
 * - _v (Number): record version — kept as its own attribute for the
 *   `ConditionExpression` compare-and-swap
 * - _ts (String): timestamp — kept as its own attribute for ordering
 * - _env (String): `JSON.stringify(envelope)` — the ENTIRE envelope, every
 *   field. New writes only touch pk/sk/_v/_ts/_env; the whole record
 *   round-trips through this one opaque attribute (no more silently
 *   dropping fields the item-mapper doesn't know about, e.g. `_cek`/`_debug`).
 * - _iv, _data, _del (legacy, optional): per-field attributes written by
 *   versions of this store before the `_env` migration. Retained ONLY so
 *   rows written before this change keep reading correctly (dual-read
 *   fallback in `itemToEnvelope`) — no data migration required (pre-1.0).
 */
export function toAwsDynamo(options: DynamoOptions): NoydbStore {
  const { table } = options

  // Lazy client initialization — only creates the client when first used
  let clientPromise: Promise<DynamoDocClient> | null = null

  async function getClient(): Promise<DynamoDocClient> {
    if (options.client) return options.client

    if (!clientPromise) {
      clientPromise = (async () => {
        // Dynamic import to keep @aws-sdk as a peer dep
        const { DynamoDBClient } = await import('@aws-sdk/client-dynamodb') as { DynamoDBClient: new (config: Record<string, unknown>) => unknown }
        const { DynamoDBDocumentClient } = await import('@aws-sdk/lib-dynamodb') as { DynamoDBDocumentClient: { from: (client: unknown) => DynamoDocClient } }

        const config: Record<string, unknown> = {}
        if (options.region) config['region'] = options.region
        if (options.endpoint) config['endpoint'] = options.endpoint
        if (options.credentials) config['credentials'] = async () => mapAws(await options.credentials!())

        const ddbClient = new DynamoDBClient(config)
        return DynamoDBDocumentClient.from(ddbClient)
      })()
    }

    return clientPromise
  }

  function sk(collection: string, id: string): string {
    return `${collection}#${id}`
  }

  function parseSk(sortKey: string): { collection: string; id: string } {
    const idx = sortKey.indexOf('#')
    return {
      collection: sortKey.slice(0, idx),
      id: sortKey.slice(idx + 1),
    }
  }

  function itemToEnvelope(item: Record<string, unknown>): EncryptedEnvelope {
    const env = item['_env'] as string | undefined
    if (env != null) {
      return JSON.parse(env) as EncryptedEnvelope
    }
    // Legacy dual-read fallback: item written before the `_env` migration —
    // reconstruct from the old per-attribute layout.
    return {
      _noydb: 1,
      _v: item['_v'] as number,
      _ts: item['_ts'] as string,
      _iv: item['_iv'] as string,
      _data: item['_data'] as string,
      ...(item['_del'] === true && { _del: true as const }),
    }
  }

  return {
    name: 'dynamo',

    // #321 — DynamoDB's conditional PutItem (`ConditionExpression` on `_v`)
    // is an atomic compare-and-swap, so it can back `vault.sequence()`.
    // (`maxBlobBytes` — the 400 KB item-limit chunking hint — is intentionally
    // left for the broader capabilities audit, where blob behavior can be
    // verified against real DynamoDB; it would change chunking, not sequencing.)
    capabilities: {
      casAtomic: true,
      // #41 — tx() below commits via TransactWriteItems (all-or-nothing,
      // per-item ConditionExpression CAS), so the bit is declared in the
      // same change (the conformance biconditional enforces the pairing).
      txAtomic: true,
      auth: { kind: 'iam', required: true, flow: 'static' },
    },

    async get(vault, collection, id) {
      const client = await getClient()
      const { GetCommand } = await import('@aws-sdk/lib-dynamodb') as { GetCommand: new (input: GetCommandInput) => unknown }

      const result = await client.send(new GetCommand({
        TableName: table,
        Key: { pk: vault, sk: sk(collection, id) },
      })) as { Item?: Record<string, unknown> }

      if (!result.Item) return null
      return itemToEnvelope(result.Item)
    },

    async put(vault, collection, id, envelope, expectedVersion) {
      const client = await getClient()
      const { PutCommand } = await import('@aws-sdk/lib-dynamodb') as { PutCommand: new (input: PutCommandInput) => unknown }

      const item: Record<string, unknown> = {
        pk: vault,
        sk: sk(collection, id),
        _v: envelope._v,
        _ts: envelope._ts,
        _env: JSON.stringify(envelope),
      }

      const input: PutCommandInput = { TableName: table, Item: item }

      if (expectedVersion !== undefined) {
        input.ConditionExpression = '#v = :expected OR attribute_not_exists(pk)'
        input.ExpressionAttributeNames = { '#v': '_v' }
        input.ExpressionAttributeValues = { ':expected': expectedVersion }
      }

      try {
        await client.send(new PutCommand(input))
      } catch (err: unknown) {
        if (err instanceof Error && err.name === 'ConditionalCheckFailedException') {
          // Fetch current version for error
          const current = await this.get(vault, collection, id)
          throw new ConflictError(
            current?._v ?? 0,
            `Version conflict: expected ${expectedVersion}, found ${current?._v}`,
          )
        }
        throw err
      }
    },

    async delete(vault, collection, id) {
      const client = await getClient()
      const { DeleteCommand } = await import('@aws-sdk/lib-dynamodb') as { DeleteCommand: new (input: DeleteCommandInput) => unknown }

      await client.send(new DeleteCommand({
        TableName: table,
        Key: { pk: vault, sk: sk(collection, id) },
      }))
    },

    async list(vault, collection) {
      const client = await getClient()
      const { QueryCommand } = await import('@aws-sdk/lib-dynamodb') as { QueryCommand: new (input: QueryCommandInput) => unknown }

      const result = await client.send(new QueryCommand({
        TableName: table,
        KeyConditionExpression: 'pk = :pk AND begins_with(sk, :prefix)',
        ExpressionAttributeValues: {
          ':pk': vault,
          ':prefix': `${collection}#`,
        },
      })) as { Items?: Record<string, unknown>[] }

      return (result.Items ?? []).map(item => {
        const { id } = parseSk(item['sk'] as string)
        return id
      })
    },

    async loadAll(vault) {
      const client = await getClient()
      const { QueryCommand } = await import('@aws-sdk/lib-dynamodb') as { QueryCommand: new (input: QueryCommandInput) => unknown }

      const result = await client.send(new QueryCommand({
        TableName: table,
        KeyConditionExpression: 'pk = :pk',
        ExpressionAttributeValues: { ':pk': vault },
      })) as { Items?: Record<string, unknown>[] }

      const snapshot: VaultSnapshot = {}

      for (const item of result.Items ?? []) {
        const sortKey = item['sk'] as string
        const { collection, id } = parseSk(sortKey)

        if (collection.startsWith('_')) continue // skip _keyring, _sync

        if (!snapshot[collection]) {
          snapshot[collection] = {}
        }
        snapshot[collection][id] = itemToEnvelope(item)
      }

      return snapshot
    },

    async saveAll(vault, data) {
      // Use individual puts (DynamoDB batch write has limitations with conditions)
      for (const [collName, records] of Object.entries(data)) {
        for (const [id, envelope] of Object.entries(records)) {
          await this.put(vault, collName, id, envelope)
        }
      }
    },

    async ping() {
      try {
        const client = await getClient()
        const { QueryCommand } = await import('@aws-sdk/lib-dynamodb') as { QueryCommand: new (input: QueryCommandInput) => unknown }

        await client.send(new QueryCommand({
          TableName: table,
          KeyConditionExpression: 'pk = :pk',
          ExpressionAttributeValues: { ':pk': '__ping__' },
        }))
        return true
      } catch {
        return false
      }
    },

    async tx(ops: readonly TxOp[]) {
      // TransactWriteItems hard ceiling. Splitting would break atomicity, so
      // over-limit batches THROW — the hub treats any tx() throw as
      // nothing-applied, which TransactWriteItems guarantees. (The 4 MB
      // aggregate request limit surfaces as the SDK's ValidationException.)
      if (ops.length > 100) {
        throw new Error(
          `to-aws-dynamo: tx() batch of ${ops.length} ops exceeds DynamoDB's TransactWriteItems limit of 100 items — ` +
          `the batch was NOT split (splitting would break atomicity) and nothing was applied`,
        )
      }
      const client = await getClient()
      const { TransactWriteCommand } = await import('@aws-sdk/lib-dynamodb') as { TransactWriteCommand: new (input: { TransactItems: unknown[] }) => unknown }

      const transactItems = ops.map(op => {
        // Per-item CAS: expectedVersion 0 = create-only; N = item must exist
        // at exactly _v = N (a missing item fails `#v = :expected` too).
        const cond = op.expectedVersion === undefined
          ? {}
          : op.expectedVersion === 0
            ? { ConditionExpression: 'attribute_not_exists(pk)' }
            : {
                ConditionExpression: '#v = :expected',
                ExpressionAttributeNames: { '#v': '_v' },
                ExpressionAttributeValues: { ':expected': op.expectedVersion },
              }
        if (op.type === 'put') {
          if (!op.envelope) throw new Error(`tx put op missing envelope for ${op.id}`)
          return {
            Put: {
              TableName: table,
              Item: {
                pk: op.vault,
                sk: sk(op.collection, op.id),
                _v: op.envelope._v,
                _ts: op.envelope._ts,
                _env: JSON.stringify(op.envelope),
              },
              ...cond,
            },
          }
        }
        return { Delete: { TableName: table, Key: { pk: op.vault, sk: sk(op.collection, op.id) }, ...cond } }
      })

      try {
        await client.send(new TransactWriteCommand({ TransactItems: transactItems }))
      } catch (err: unknown) {
        // TransactionCanceledException carries per-item CancellationReasons;
        // a ConditionalCheckFailed entry pinpoints the conflicting op. The
        // whole transaction was rejected — nothing was applied.
        const reasons = (err as { CancellationReasons?: Array<{ Code?: string }> }).CancellationReasons
        const idx = err instanceof Error && err.name === 'TransactionCanceledException'
          ? (reasons?.findIndex(r => r.Code === 'ConditionalCheckFailed') ?? -1)
          : err instanceof Error && err.name === 'ConditionalCheckFailedException'
            ? ops.findIndex(o => o.expectedVersion !== undefined)
            : -1
        if (idx >= 0) {
          const op = ops[idx]!
          const current = await this.get(op.vault, op.collection, op.id)
          throw new ConflictError(
            current?._v ?? 0,
            `tx version conflict on ${op.collection}/${op.id}: expected ${op.expectedVersion}, found ${current?._v ?? 'no item'}`,
          )
        }
        throw err
      }
    },

    /**
     * Paginate over a collection using DynamoDB's native `LastEvaluatedKey`
     * cursor. The cursor is base64-encoded JSON of the LastEvaluatedKey
     * object so it round-trips through any caller transport.
     *
     * Each page is a single Query call against the partition key, so the
     * read cost is `pageSize ÷ 4 KB` RCUs (eventually consistent) per page.
     */
    async listPage(vault, collection, cursor, limit = 100) {
      const client = await getClient()
      const { QueryCommand } = await import('@aws-sdk/lib-dynamodb') as { QueryCommand: new (input: QueryCommandInput) => unknown }

      const input: QueryCommandInput = {
        TableName: table,
        KeyConditionExpression: 'pk = :pk AND begins_with(sk, :prefix)',
        ExpressionAttributeValues: {
          ':pk': vault,
          ':prefix': `${collection}#`,
        },
        Limit: limit,
      }
      if (cursor) {
        input.ExclusiveStartKey = JSON.parse(b64decode(cursor)) as Record<string, unknown>
      }

      const result = await client.send(new QueryCommand(input)) as {
        Items?: Record<string, unknown>[]
        LastEvaluatedKey?: Record<string, unknown>
      }

      const items: Array<{ id: string; envelope: EncryptedEnvelope }> = []
      for (const item of result.Items ?? []) {
        const { id } = parseSk(item['sk'] as string)
        items.push({ id, envelope: itemToEnvelope(item) })
      }

      const nextCursor = result.LastEvaluatedKey
        ? b64encode(JSON.stringify(result.LastEvaluatedKey))
        : null

      return { items, nextCursor }
    },
  }
}

/**
 * Tiny base64 helpers that work in both Node 20+ and any modern browser
 * without pulling in @types/node or relying on a Buffer polyfill. The
 * dynamo adapter has zero non-AWS dependencies and we want to keep it
 * that way — listPage cursors are short JSON blobs so the per-call cost
 * of these helpers is negligible.
 */
function b64encode(input: string): string {
  // btoa expects a Latin-1 string; encodeURIComponent + unescape is the
  // canonical trick for utf-8 → btoa-safe payloads.
  return btoa(unescape(encodeURIComponent(input)))
}

function b64decode(input: string): string {
  return decodeURIComponent(escape(atob(input)))
}

// ─── Store-locator descriptor (#58 — `cloud` class) ──────────────────

/** Serializable location of a DynamoDB store: table + region + endpoint. */
export interface DynamoAddress {
  readonly table: string
  readonly region?: string
  readonly endpoint?: string
}

/**
 * Device-local supplement resolved at `resolve()` time — a pre-built
 * document client (shared client, custom middleware, or a test fake).
 * Never serialized into a pod alongside the descriptor. This is
 * `to-aws-dynamo`'s binding-slot citizen (#58) — when supplied, it
 * always wins over address-derived construction.
 */
export interface DynamoBinding {
  readonly client?: DynamoDocClient
}

/**
 * Builds the `StoreDescriptor` form of a `toAwsDynamo()` store:
 * `kind: 'aws-dynamo'`, `class: 'cloud'`. Credentialless by construction —
 * AWS credentials arrive via `StoreCredentialSource` at `resolve()` time
 * (the #479 broker seam), or implicitly via the SDK's default provider
 * chain on the device.
 *
 * Takes no options argument: this store has no serializable tuning today.
 */
export function dynamoStoreDescriptor(address: DynamoAddress): StoreDescriptor {
  return { kind: 'aws-dynamo', class: 'cloud', address }
}

/**
 * `StoreFactory` for `to-aws-dynamo`: reconstructs the same store
 * `toAwsDynamo()` builds, from a descriptor produced by
 * {@link dynamoStoreDescriptor}. `opts.credentials` becomes the SDK's
 * refresh hook; `opts.binding` may carry a pre-built client
 * ({@link DynamoBinding}), which always wins.
 */
export const dynamoStoreFactory: StoreFactory = (descriptor, opts) => {
  const { table, region, endpoint } = descriptor.address as DynamoAddress
  const binding = (opts.binding ?? {}) as DynamoBinding
  return toAwsDynamo({
    table,
    ...(region !== undefined && { region }),
    ...(endpoint !== undefined && { endpoint }),
    ...(opts.credentials !== undefined && { credentials: opts.credentials }),
    ...(binding.client !== undefined && { client: binding.client }),
  })
}

/** Registers {@link dynamoStoreFactory} under the `'aws-dynamo'` kind on `locator`. */
export function registerDynamoStore(locator: StoreLocator): void {
  locator.register('aws-dynamo', dynamoStoreFactory)
}
