# @noy-db/to-mysql

[![npm](https://img.shields.io/npm/v/%40noy-db/to-mysql.svg)](https://www.npmjs.com/package/@noy-db/to-mysql)

> MySQL / MariaDB adapter for noy-db

Part of [**`@noy-db/hub`**](https://www.npmjs.com/package/@noy-db/hub) — the zero-knowledge, offline-first, encrypted document store.

## Install

```bash
pnpm add @noy-db/hub @noy-db/to-mysql
```

## What it is

MySQL / MariaDB adapter for noy-db — encrypted-envelope KV with JSON column. Works with any duck-typed mysql2-style pool/connection. casAtomic: true via UPDATE … WHERE v = ?.

## Status

**Pre-release** (`0.1.0-pre.1`). API may change before `1.0`.

## Documentation

See the [main repository](https://github.com/noy-db/core#readme) for setup, examples, and the full subsystem catalog.

- Source — [`packages/to-mysql`](https://github.com/noy-db/to/tree/main/to-mysql)
- Issues — [github.com/noy-db/to/issues](https://github.com/noy-db/to/issues)
- Spec — [`SPEC.md`](https://github.com/noy-db/core/blob/main/SPEC.md)

## License

[MIT](./LICENSE) © vLannaAi
