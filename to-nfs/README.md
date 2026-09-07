# @noy-db/to-nfs

[![npm](https://img.shields.io/npm/v/%40noy-db/to-nfs.svg)](https://www.npmjs.com/package/@noy-db/to-nfs)

> NFS network-file store for noy-db. Same JSON-file indexed layout as the local file store, with pre-flight checks for nolock / noac mount options that silently break versioning guarantees on stock NFS mounts.

Part of [**`@noy-db/hub`**](https://www.npmjs.com/package/@noy-db/hub) — the zero-knowledge, offline-first, encrypted document store.

## Install

```bash
pnpm add @noy-db/hub @noy-db/to-nfs
```

## What it is

NFS network-file store for noy-db. Same JSON-file indexed layout as the local file store, with pre-flight checks for nolock / noac mount options that silently break versioning guarantees on stock NFS mounts.

## Mount diagnostics

The store runs pre-flight checks against the mount on first I/O and caches the
result. `store.diagnostics()` returns the raw risk list at any time.

| check | default | escalate with |
|---|---|---|
| `nolock` — POSIX locks silently disabled, so concurrent writers can corrupt records | warn | `onNolock: 'error'` |
| attribute caching (no `noac`) — a version check can pass on stale cached data | warn (report only) | — |
| wrong fstype — the path is mounted as ext4/apfs, not NFS | warn (report only) | — |
| **device mismatch** — the `server:/export` this store claims is not what `mountPath` is actually mounted from | warn | `onDeviceMismatch: 'error'` |

The device check is the one that catches a *misrouted* store rather than a
misconfigured one. `server`/`export` state which export the store believes it is
talking to; `mountPath` says where that export is mounted on this machine. The
split is deliberate — where something is mounted is device-local and must never
travel in a pod — but it means the two can disagree, and writes then land
somewhere else silently and permanently.

```ts
const store = toNfs({
  mountPath: '/mnt/vaults',           // device-local: where it is mounted here
  server: 'nas.local',                // logical identity: which export this is
  export: '/exports/vaults',
  onDeviceMismatch: 'error',          // default is 'warn'
})
```

Both halves of the identity are required — a half-stated claim is not
checkable, and omitting them entirely skips the check, so existing consumers
are unaffected.

## Status

**Pre-release** (`0.1.0-pre.1`). API may change before `1.0`.

## Documentation

See the [main repository](https://github.com/noy-db/core#readme) for setup, examples, and the full subsystem catalog.

- Source — [`to-nfs`](https://github.com/noy-db/to/tree/main/to-nfs)
- Issues — [github.com/noy-db/to/issues](https://github.com/noy-db/to/issues)
- Spec — [`SPEC.md`](https://github.com/noy-db/core/blob/main/SPEC.md)

## License

[MIT](./LICENSE) © vLannaAi
