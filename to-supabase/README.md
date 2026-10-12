# @noy-db/to-supabase

[![npm](https://img.shields.io/npm/v/%40noy-db/to-supabase.svg)](https://www.npmjs.com/package/@noy-db/to-supabase)

> Supabase adapter for noy-db

Part of [**`@noy-db/hub`**](https://www.npmjs.com/package/@noy-db/hub) — the zero-knowledge, offline-first, encrypted document store.

## Install

```bash
pnpm add @noy-db/hub @noy-db/to-supabase @noy-db/to-postgres
```

## What it is

Supabase adapter for noy-db — a thin factory over @noy-db/to-postgres for your Supabase Postgres connection (a `pg.Pool` or `pg.Client`). Records only: it does not route blobs to Supabase Storage.

## Status

**Pre-release.** API may change before `1.0`.

## Documentation

See the [main repository](https://github.com/noy-db/core#readme) for setup, examples, and the full subsystem catalog.

- Source — [`to-supabase`](https://github.com/noy-db/to/tree/main/to-supabase)
- Issues — [github.com/noy-db/to/issues](https://github.com/noy-db/to/issues)
- Spec — [`SPEC.md`](https://github.com/noy-db/core/blob/main/SPEC.md)

## License

[Apache-2.0](./LICENSE) © vLannaAi
