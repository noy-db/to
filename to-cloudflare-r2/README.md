# @noy-db/to-cloudflare-r2

[![npm](https://img.shields.io/npm/v/%40noy-db/to-cloudflare-r2.svg)](https://www.npmjs.com/package/@noy-db/to-cloudflare-r2)

> Cloudflare R2 adapter for noy-db

Part of [**`@noy-db/hub`**](https://www.npmjs.com/package/@noy-db/hub) — the zero-knowledge, offline-first, encrypted document store.

## Install

```bash
pnpm add @noy-db/hub @noy-db/to-cloudflare-r2
```

## What it is

Cloudflare R2 adapter for noy-db — S3-compatible object storage with zero egress fees. Thin wrapper around @noy-db/to-aws-s3 configured for the R2 endpoint. casAtomic: false (same caveat as S3).

> #### ⚠️ `prefix` must NOT end in a slash
>
> `prefix` is forwarded straight to `toAwsS3()`, so it inherits that package's key layout
> **and its validation**: a trailing slash produces an empty path segment
> (`tenant-a//alice/…`) and is refused at construction. Because the check lives upstream,
> the error names `@noy-db/to-aws-s3` even though you called `toCloudflareR2()`.
>
> If you are already running a trailing slash, your objects are under the double-separator
> form and are not moved by fixing the config. See
> [`@noy-db/to-aws-s3`](https://www.npmjs.com/package/@noy-db/to-aws-s3) and noy-db-to#109.

## Status

**Pre-release** (`0.1.0-pre.1`). API may change before `1.0`.

## Documentation

See the [main repository](https://github.com/noy-db/core#readme) for setup, examples, and the full subsystem catalog.

- Source — [`to-cloudflare-r2`](https://github.com/noy-db/to/tree/main/to-cloudflare-r2)
- Issues — [github.com/noy-db/to/issues](https://github.com/noy-db/to/issues)
- Spec — [`SPEC.md`](https://github.com/noy-db/core/blob/main/SPEC.md)

## License

[MIT](./LICENSE) © vLannaAi
