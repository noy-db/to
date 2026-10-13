# @noy-db/to-ssh

[![npm](https://img.shields.io/npm/v/%40noy-db/to-ssh.svg)](https://www.npmjs.com/package/@noy-db/to-ssh)

> SSH/SFTP store for noy-db

Part of [**`@noy-db/hub`**](https://www.npmjs.com/package/@noy-db/hub) — the zero-knowledge, offline-first, encrypted document store.

## Install

```bash
pnpm add @noy-db/hub @noy-db/to-ssh
```

## What it is

SSH/SFTP store for noy-db — remote encrypted document storage over SSH using public-key auth. Any Linux/macOS server with sshd running becomes a noy-db backend; leverages existing ~/.ssh keys or ssh-agent. Key-only auth (no passwords).

## Ids that differ only by case

An SFTP server folds case when its disk does (APFS, NTFS), so `abc.json` would open an existing `Abc.json` and replace that record. The store
probes the server once, on its first write, and on a case-folding server refuses a `put` or
`saveAll` whose id differs from an existing one only by case, in any `/`-separated component.
Each write on such a server then costs one directory listing per id component. On a
case-sensitive server nothing changes.

## Status

**Pre-release.** API may change before `1.0`.

## Documentation

See the [main repository](https://github.com/noy-db/core#readme) for setup, examples, and the full subsystem catalog.

- Source — [`packages/to-ssh`](https://github.com/noy-db/to/tree/main/to-ssh)
- Issues — [github.com/noy-db/to/issues](https://github.com/noy-db/to/issues)
- Spec — [`SPEC.md`](https://github.com/noy-db/core/blob/main/SPEC.md)

## License

[Apache-2.0](./LICENSE) © vLannaAi
