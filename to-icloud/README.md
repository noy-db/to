# @noy-db/to-icloud

[![npm](https://img.shields.io/npm/v/%40noy-db/to-icloud.svg)](https://www.npmjs.com/package/@noy-db/to-icloud)

> iCloud Drive bundle store for noy-db

Part of [**`@noy-db/hub`**](https://www.npmjs.com/package/@noy-db/hub) — the zero-knowledge, offline-first, encrypted document store.

## Install

```bash
pnpm add @noy-db/hub @noy-db/to-icloud
```

Requires `@noy-db/hub >= 0.4.0-pre.11`: this store conforms through the hub's `wrapPodStore()`, and concurrent-write correctness lives in that wrapper (fixed in noy-db#908).

## What it is

iCloud Drive bundle store for noy-db — macOS-aware persistence that handles both eviction shapes (modern dataless-in-place and legacy .icloud stubs) and detects conflict files automatically. Treats each vault as a single .noydb bundle, safe for the Apple ecosystem.

## Eviction: two shapes

iCloud evicts a file's contents to cloud-only storage in one of two shapes,
and which one you get depends on the macOS version.

| | modern (Darwin 24.6 / Sequoia, verified) | legacy |
|---|---|---|
| what appears on disk | the canonical file, **APFS-dataless** — `stat` reports full logical size, `du` reports 0 bytes | a separate `<name>.icloud` placeholder |
| what a plain read does | **blocks transparently** while the OS rehydrates, then succeeds (~0.7 s for a 195 KB bundle) | fails; needs an explicit download trigger |
| what this store does | nothing special — the ordinary read path is correct | detects the stub and calls `triggerDownload` |

On current macOS the stub branch never fires. It is retained for older macOS
and other sync surfaces that still materialise a placeholder file.

**The practical consequence is latency, not errors.** A read of an evicted
bundle can block on the network with no advance signal. Distinguishing
evicted-dataless from locally-present requires comparing allocated blocks
(`st_blocks`) against logical size, which the duck-typed `ICloudFs` facade
does not currently expose — tracked in
[#15](https://github.com/noy-db/to/issues/15).

## Status

**Pre-release** (`0.1.0-pre.1`). API may change before `1.0`.

## Documentation

See the [main repository](https://github.com/noy-db/core#readme) for setup, examples, and the full subsystem catalog.

- Source — [`to-icloud`](https://github.com/noy-db/to/tree/main/to-icloud)
- Issues — [github.com/noy-db/to/issues](https://github.com/noy-db/to/issues)
- Spec — [`SPEC.md`](https://github.com/noy-db/core/blob/main/SPEC.md)

## License

[Apache-2.0](./LICENSE) © vLannaAi
