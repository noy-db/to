# @noy-db/to-aws-s3

> AWS S3 adapter for [noy-db](https://github.com/noy-db/core) — encrypted object storage with zero-knowledge cloud sync.

[![npm](https://img.shields.io/npm/v/@noy-db/to-aws-s3.svg)](https://www.npmjs.com/package/@noy-db/to-aws-s3)

## Install

```bash
pnpm add @noy-db/hub @noy-db/to-aws-s3 @aws-sdk/client-s3
```

`@aws-sdk/client-s3` is a peer dependency — install it in your app.

## Usage

```ts
import { createNoydb } from '@noy-db/hub'
import { toAwsS3 } from '@noy-db/to-aws-s3'
import { S3Client } from '@aws-sdk/client-s3'

const client = new S3Client({ region: 'ap-southeast-1' })

const db = await createNoydb({
  store: toAwsS3({ client, bucket: 'noydb-prod', prefix: 'tenant-a' }),
  user: 'alice',
  secret: userSecret, // from your unlock flow or environment; never hard-code it
})
```

Each record becomes an S3 object containing only a ciphertext envelope. S3 never sees plaintext — even with full bucket access, an attacker learns nothing without the user's secret.

Best suited for:

- Infrequent-access archival with strong privacy guarantees
- Cold storage of audit trails and backups
- Lower-cost alternative to DynamoDB for small teams

## Key layout

Records are stored one object per record:

```
{prefix}/{vault}/{collection}/{id}.json
```

with the prefix omitted entirely when it is not configured (`{vault}/{collection}/{id}.json`).
A `getStoreTime()` sentinel lives at `{prefix}/_noydb-clock`, outside any vault.

> #### ⚠️ `prefix` must NOT end in a slash
>
> The separator is appended unconditionally, so `prefix: 'tenant-a/'` produces
> `tenant-a//alice/docs/d1.json` — an **empty path segment**, not the key you meant.
>
> This bites twice. `tenant-a` and `tenant-a/` address **different objects**, so changing
> one into the other in a config silently orphans every record already written; and a policy
> written against `tenant-a/{vault}/*` finds the vault in the third segment rather than the
> second.
>
> **`toAwsS3()` now REFUSES a trailing slash at construction** rather than trimming it,
> and the error names the consequence. Trimming would have been the obvious fix and is
> the wrong one: it silently relocates every existing record for anyone already running a
> trailing slash, with no error to notice. Both refusing and trimming force the same
> migration — only refusing lets you see it coming.
>
> #### If you are already running a trailing slash
>
> Your objects are under the **double-separator** form, and removing the slash does not
> move them:
>
> ```
> before   tenant-a//alice/docs/d1.json      ← where your data is
> after    tenant-a/alice/docs/d1.json       ← where the store will look
> ```
>
> Copy the objects to the single-separator keys **before** switching the config, or they
> become unreachable. No compatibility flag is offered, deliberately: that would encode
> an accident permanently.
>
> Pinned by `__tests__/key-layout.test.ts`. See noy-db-to#109.

## Direct-to-cloud clients: IAM scoping

The key layout above **is a deployment contract** — it is what a policy confining a browser
client to its own vault must be written against, which is why it is documented here rather
than left as an implementation detail, and why a test pins it against this page.

The vault name is the first path segment after the prefix, so a key-prefix condition
confines a client to exactly one vault:

```jsonc
{
  "Effect": "Allow",
  "Action": ["s3:GetObject", "s3:PutObject", "s3:DeleteObject"],
  "Resource": "arn:aws:s3:::noydb-prod/tenant-a/${vault-name}/*"
}
```

`loadAll()` and the paged listings additionally need `s3:ListBucket` on the **bucket**,
scoped with an `s3:prefix` condition of `tenant-a/${vault-name}/*`.

Those, plus `s3:GetObject` on `{prefix}/_noydb-clock` if you call `getStoreTime()`, are the
complete set of operations this store issues. Enforcement is IAM's job — the store's only
obligation is to produce a key layout conditions can be written against, and to tell you
what it is.

### ⚠️ `ping()` and `getStoreTime()` are denied by a vault-scoped policy

`ping()` issues a `HeadBucket` against the whole bucket, and `getStoreTime()` writes the
`_noydb-clock` sentinel that sits **outside** any vault. Neither is reachable under a policy
scoped to `tenant-a/${vault-name}/*`.

Either widen the policy to cover them explicitly, or do not rely on them from scoped
clients. `ping()` swallows its error and returns `false`, so it reports an unreachable store
when the store is fine and the client simply is not allowed to ask.

### Credentials

Pass a `credentials` provider rather than static keys, so a browser client never holds a
long-lived secret:

```ts
import { toAwsS3 } from '@noy-db/to-aws-s3'

toAwsS3({
  bucket: 'noydb-prod',
  region: 'ap-southeast-1',
  prefix: 'tenant-a',
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
