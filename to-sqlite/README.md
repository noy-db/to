# @noy-db/to-sqlite

[![npm](https://img.shields.io/npm/v/%40noy-db/to-sqlite.svg)](https://www.npmjs.com/package/@noy-db/to-sqlite)

> SQLite adapter for noy-db

Part of [**`@noy-db/hub`**](https://www.npmjs.com/package/@noy-db/hub) — the zero-knowledge, offline-first, encrypted document store.

## Install

```bash
pnpm add @noy-db/hub @noy-db/to-sqlite
```

## What it is

SQLite adapter for noy-db — single-file local encrypted document store. Works with better-sqlite3, node:sqlite (Node 22+), or bun:sqlite via a duck-typed Database interface. casAtomic: true (BEGIN IMMEDIATE + UPDATE WHERE _v=?).

## Status

**Pre-release** (`0.1.0-pre.1`). API may change before `1.0`.

## Documentation

See the [main repository](https://github.com/noy-db/core#readme) for setup, examples, and the full subsystem catalog.

- Source — [`packages/to-sqlite`](https://github.com/noy-db/to/tree/main/to-sqlite)
- Issues — [github.com/noy-db/to/issues](https://github.com/noy-db/to/issues)
- Spec — [`SPEC.md`](https://github.com/noy-db/core/blob/main/SPEC.md)

## License

[MIT](./LICENSE) © vLannaAi
