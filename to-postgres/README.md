# @noy-db/to-postgres

[![npm](https://img.shields.io/npm/v/%40noy-db/to-postgres.svg)](https://www.npmjs.com/package/@noy-db/to-postgres)

> PostgreSQL adapter for noy-db

Part of [**`@noy-db/hub`**](https://www.npmjs.com/package/@noy-db/hub) — the zero-knowledge, offline-first, encrypted document store.

## Install

```bash
pnpm add @noy-db/hub @noy-db/to-postgres
```

## What it is

PostgreSQL adapter for noy-db — encrypted-envelope KV with jsonb column. Works with any duck-typed pg-style Client (node-postgres, postgres.js, pg-native, Supabase, Neon serverless). casAtomic: true via UPDATE … WHERE _v = ?.

## Status

**Pre-release** (`0.1.0-pre.1`). API may change before `1.0`.

## Documentation

See the [main repository](https://github.com/noy-db/core#readme) for setup, examples, and the full subsystem catalog.

- Source — [`packages/to-postgres`](https://github.com/noy-db/to/tree/main/to-postgres)
- Issues — [github.com/noy-db/to/issues](https://github.com/noy-db/to/issues)
- Spec — [`SPEC.md`](https://github.com/noy-db/core/blob/main/SPEC.md)

## License

[MIT](./LICENSE) © vLannaAi
