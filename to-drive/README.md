# @noy-db/to-drive

[![npm](https://img.shields.io/npm/v/%40noy-db/to-drive.svg)](https://www.npmjs.com/package/@noy-db/to-drive)

> Google Drive bundle store for noy-db. Stores the whole vault as a single .noydb file in Drive's hidden appDataFolder; opaque ULID filenames never leak compartment names. Driver-agnostic

Part of [**`@noy-db/hub`**](https://www.npmjs.com/package/@noy-db/hub) — the zero-knowledge, offline-first, encrypted document store.

## Install

```bash
pnpm add @noy-db/hub @noy-db/to-drive
```

Requires `@noy-db/hub >= 0.4.0-pre.11`: this store conforms through the hub's `wrapPodStore()`, and concurrent-write correctness lives in that wrapper (fixed in noy-db#908).

## What it is

Google Drive bundle store for noy-db. Stores the whole vault as a single .noydb file in Drive's hidden appDataFolder; opaque ULID filenames never leak compartment names. Driver-agnostic — bring your own OAuth token.

## Status

**Pre-release** (`0.1.0-pre.1`). API may change before `1.0`.

## Documentation

See the [main repository](https://github.com/noy-db/core#readme) for setup, examples, and the full subsystem catalog.

- Source — [`to-drive`](https://github.com/noy-db/to/tree/main/to-drive)
- Issues — [github.com/noy-db/to/issues](https://github.com/noy-db/to/issues)
- Spec — [`SPEC.md`](https://github.com/noy-db/core/blob/main/SPEC.md)

## License

[Apache-2.0](./LICENSE) © vLannaAi
