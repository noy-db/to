# @noy-db/to-turso

[![npm](https://img.shields.io/npm/v/%40noy-db/to-turso.svg)](https://www.npmjs.com/package/@noy-db/to-turso)

> Turso / libSQL adapter for noy-db

Part of [**`@noy-db/hub`**](https://www.npmjs.com/package/@noy-db/hub) — the zero-knowledge, offline-first, encrypted document store.

## Install

```bash
pnpm add @noy-db/hub @noy-db/to-turso
```

## What it is

Turso / libSQL adapter for noy-db — edge SQLite with built-in replication. Wraps @libsql/client through a small async shim that speaks the same noy-db store contract as @noy-db/to-sqlite.

## Atomicity (`txAtomic`) depends on the injected client

`capabilities.txAtomic` is declared **conditionally at construction**: libSQL's `batch()`
runs its statements in one implicit transaction, so the atomic-batch guarantee is honest
exactly when the client exposes `batch`.

- `client` **with** `batch` (every real `@libsql/client`) → `txAtomic: true`; `tx()` submits
  one batch with in-batch `expectedVersion` guards — all-or-nothing, mismatch throws `ConflictError`.
- `client` **without** `batch` (duck-typed injections) → `txAtomic: false`; `tx()` falls back
  to sequential statements with **no** atomicity guarantee, and the hub will not delegate to it.
- `clientFactory` path → `true` (factory-built clients are real `@libsql/client` instances).

## Status

**Pre-release** (`0.1.0-pre.1`). API may change before `1.0`.

## Documentation

See the [main repository](https://github.com/noy-db/core#readme) for setup, examples, and the full subsystem catalog.

- Source — [`packages/to-turso`](https://github.com/noy-db/to/tree/main/to-turso)
- Issues — [github.com/noy-db/to/issues](https://github.com/noy-db/to/issues)
- Spec — [`SPEC.md`](https://github.com/noy-db/core/blob/main/SPEC.md)

## License

[MIT](./LICENSE) © vLannaAi
