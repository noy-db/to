# @noy-db/to-webdav

[![npm](https://img.shields.io/npm/v/%40noy-db/to-webdav.svg)](https://www.npmjs.com/package/@noy-db/to-webdav)

> WebDAV adapter for noy-db

Part of [**`@noy-db/hub`**](https://www.npmjs.com/package/@noy-db/hub) — the zero-knowledge, offline-first, encrypted document store.

## Install

```bash
pnpm add @noy-db/hub @noy-db/to-webdav
```

## What it is

WebDAV adapter for noy-db — encrypted object storage over the WebDAV protocol. Works with Nextcloud, ownCloud, Apache mod_dav, and any RFC 4918 server. Pure fetch()-based, zero dependencies.

## Ids that differ only by case

A WebDAV server folds case when its disk does (APFS, NTFS), so `abc.json` would open an existing `Abc.json` and replace that record. The store
probes the server once, on its first write, and on a case-folding server refuses a `put` or
`saveAll` whose id differs from an existing one only by case, in any `/`-separated component.
Each write on such a server then costs one directory listing per id component. On a
case-sensitive server nothing changes.

## Status

**Pre-release.** API may change before `1.0`.

## Documentation

See the [main repository](https://github.com/noy-db/core#readme) for setup, examples, and the full subsystem catalog.

- Source — [`packages/to-webdav`](https://github.com/noy-db/to/tree/main/to-webdav)
- Issues — [github.com/noy-db/to/issues](https://github.com/noy-db/to/issues)
- Spec — [`SPEC.md`](https://github.com/noy-db/core/blob/main/SPEC.md)

## License

[Apache-2.0](./LICENSE) © vLannaAi
