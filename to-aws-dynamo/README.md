# @noy-db/to-aws-dynamo

> AWS DynamoDB adapter for [noy-db](https://github.com/noy-db/core) — single-table design, zero-knowledge cloud sync.

[![npm](https://img.shields.io/npm/v/@noy-db/to-aws-dynamo.svg)](https://www.npmjs.com/package/@noy-db/to-aws-dynamo)

## Install

```bash
pnpm add @noy-db/hub @noy-db/to-aws-dynamo @aws-sdk/client-dynamodb @aws-sdk/lib-dynamodb
```

`@aws-sdk/*` packages are peer dependencies — install them in your app.

## Usage

```ts
import { createNoydb } from '@noy-db/hub'
import { toAwsDynamo } from '@noy-db/to-aws-dynamo'
import { DynamoDBClient } from '@aws-sdk/client-dynamodb'
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb'

const client = DynamoDBDocumentClient.from(new DynamoDBClient({ region: 'ap-southeast-1' }))

const db = await createNoydb({
  store: toAwsDynamo({ client, table: 'noydb-prod' }),
  user: 'alice',
  secret: userSecret, // from your unlock flow or environment; never hard-code it
})
```

DynamoDB only ever sees encrypted envelopes — the ciphertext is useless without the user's secret.

## Table schema

Create the table with a composite primary key. **Attribute names are lowercase** and the store depends on them exactly:

| Attribute | Type | Role |
|---|---|---|
| `pk` | String | **Partition key** — the vault name |
| `sk` | String | **Sort key** — `{collection}#{id}` |
| `_env` | String | the complete encrypted envelope, serialized as JSON |
| `_v` | Number | version, projected out of the envelope so compare-and-swap can run as a `ConditionExpression` |
| `_ts` | String | timestamp, projected out of the envelope so `listSince()` can filter server-side |

`_v` and `_ts` are duplicated out of `_env` because DynamoDB cannot express a condition over a field inside a serialized blob. **The envelope in `_env` is authoritative**; the projections are read-side conveniences.

> Earlier versions of this adapter spread the envelope across individual `_iv` / `_data` / `_by` attributes. Nothing since `0.4.0` writes that layout.

## Direct-to-cloud clients: key layout and IAM scoping

The key layout above **is a deployment contract**. It is what an IAM policy confining a client to its own vault must be written against, so it is documented here rather than left as an implementation detail, and it is pinned by `__tests__/key-layout.test.ts` so it cannot drift away from this page.

Because the vault name is the **whole** partition key — never a prefix of it, never combined with anything else — a `dynamodb:LeadingKeys` condition confines a client to exactly one vault:

```jsonc
{
  "Effect": "Allow",
  "Action": [
    "dynamodb:GetItem",
    "dynamodb:PutItem",
    "dynamodb:DeleteItem",
    "dynamodb:Query"
  ],
  "Resource": "arn:aws:dynamodb:REGION:ACCOUNT:table/noydb-prod",
  "Condition": {
    "ForAllValues:StringEquals": {
      "dynamodb:LeadingKeys": ["${vault-name}"]
    }
  }
}
```

Those four actions are the complete set this store issues, plus `dynamodb:TransactWriteItems` if you use `tx()`. Enforcement is IAM's job — the store's only obligation is to produce a key layout that conditions can be written against, and to tell you what it is.

### ⚠️ `ping()` is denied by a vault-scoped policy

`ping()` issues a `Query` against the reserved partition **`__ping__`**, which is not the client's vault. Under the condition above it is denied, and because `ping()` swallows the error it returns **`false` against a perfectly healthy table**.

Granting `dynamodb:DescribeTable` does not help — that is not the call being made. Your options are to add `__ping__` to the `LeadingKeys` list, or to accept that `ping()` reports `false` for scoped clients and not treat it as a health signal.

### Credentials

Pass a `credentials` provider rather than static keys, so a browser client never holds a long-lived secret:

```ts
import { toAwsDynamo } from '@noy-db/to-aws-dynamo'

toAwsDynamo({
  table: 'noydb-prod',
  region: 'ap-southeast-1',
  credentials: async () => ({
    kind: 'aws',
    accessKeyId: creds.AccessKeyId,
    secretAccessKey: creds.SecretAccessKey,
    sessionToken: creds.SessionToken,
    expiresAt: creds.Expiration.toISOString(),
  }),
})
```

Credentials arrive at `resolve()` time and are never serialized onto a store descriptor.

> #### ⚠️ Omitting `expiresAt` disables refresh — silently
>
> The AWS SDK memoizes the provider. A **present** `expiration` makes it re-invoke your
> hook on a rolling window before the credentials lapse; an **absent** one reads as
> *"expiry unknown, never re-invoke"*, so the hook is called **once** and the client keeps
> using the first credentials it was given until they expire mid-session.
>
> `expiresAt` is optional in the type and load-bearing in practice. If you vend
> short-lived STS credentials, always pass it.

## License

Apache-2.0 © vLannaAi — see the [noy-db repo](https://github.com/noy-db/core) for full documentation.
