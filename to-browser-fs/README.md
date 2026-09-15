# @noy-db/to-browser-fs

File System Access store for [noy-db](https://github.com/noy-db/core) — the browser
sibling to `@noy-db/to-file`.

A page cannot open a filesystem path, so mounting `Z:\` does not make a network share
reachable from a web app. This store takes a `FileSystemDirectoryHandle` instead, which
*can* point at a mounted volume. The adapter never speaks SMB, NFS, or WebDAV: once the OS
has mounted the volume, the protocol stops mattering — it is just a directory.

That makes the LAN tier buildable with no port to open, no daemon, no NAS configuration,
and no vendor: a Windows workstation shares a folder, everyone else mounts it.

```ts
import { createNoydb } from '@noy-db/hub'
import { toBrowserIdb } from '@noy-db/to-browser-idb'
import { toBrowserFs, rememberDirectory } from '@noy-db/to-browser-fs'

const handle = await showDirectoryPicker({ mode: 'readwrite' })   // once, from a click
await rememberDirectory('lan-share', handle)

const db = await createNoydb({
  store: toBrowserIdb({ prefix: 'vault' }),                        // authoritative for writes
  sync: [{ store: toBrowserFs({ handle }), role: 'sync-peer', label: 'LAN' }],
})
```

**Chromium-only, by construction.** Safari's OPFS is origin-private and structurally cannot
see a mounted volume, so there is no cross-browser version of this to want. Everyone off
Chrome reaches a cloud store instead.

## Layout — interoperable with `to-file`

```
{root}/
  {vault}/
    {collection}/
      {id}.json          ← EncryptedEnvelope, pretty-printed by default
    _keyring/
      {userId}.json
    _sync/
      meta.json
```

Byte-identical to `@noy-db/to-file`, so a Node process (a backup job, a desktop app) and a
browser can point at the same folder and read each other's writes. Underscore-prefixed
collections are skipped by `loadAll` in both.

## Permissions — the part that shapes your unlock flow

`requestPermission()` needs transient user activation, roughly five seconds in Chrome. A
vault unlock does PBKDF2 and blows straight past it. So **`requestAccess()` is the only
method in this package that ever prompts** — no read, write, sync, or `ping` will. Spend
the gesture first, then do the slow work:

```ts
// inside the click handler, BEFORE unlock
if (await store.access() !== 'granted') {
  if (!await store.requestAccess()) return   // user declined
}
await unlockVault(password)                  // slow; activation already spent
```

`access()` reports four states, because "click to reconnect" and "you are off the office
network" are different situations for the user:

| State | Meaning | What to show |
|---|---|---|
| `granted` | permission held **and** the volume answers | connected |
| `prompt` | no grant yet, or it lapsed on restart | "click to reconnect" |
| `denied` | the user refused | "reconnect from settings" |
| `unreachable` | grant held, volume does not answer | "off the office network — working locally" |

Permission is checked before the volume is touched, so an answer that permission alone
decides never waits on a dead mount. Mid-flight, failures arrive as typed errors —
`FsPermissionError` and `FsUnreachableError` — never as strings to match on.

**Across a browser restart**, expect `access()` to report `'prompt'`: a handle recalled
from IndexedDB keeps its identity, but Chromium generally does not carry the grant over
unless the app is an installed PWA. Plan for one click per session.

### Remembering the directory

`FileSystemDirectoryHandle` is structured-cloneable, so it survives in IndexedDB:

```ts
import { rememberDirectory, recallDirectory, forgetDirectory } from '@noy-db/to-browser-fs'

const handle = await recallDirectory('lan-share')   // null if never picked
```

IndexedDB clones what it stores, so a recalled handle is a new object pointing at the same
directory — compare with `isSameEntry()`, never with `===`.

## Writes

Two layers of protection against a laptop dropping Wi-Fi mid-write:

1. **Atomic replace.** `createWritable()` on a real (non-OPFS) handle stages bytes in a
   `.crswap` sidecar and swaps it into place on `close()`. A torn `{id}.json` is
   structurally impossible; a killed tab leaves an orphan sidecar, which this store filters
   out of `list`, `listPage`, and `loadAll`.
2. **Verify after write.** Every write is read back and compared, throwing
   `FsWriteVerifyError` on a mismatch — covering the silent short write or stale cache a
   swap alone does not. Costs one extra read per write; pass `verifyWrites: false` to skip
   it for bulk `saveAll` over a link you trust.

## Capabilities

| Capability | Value |
|---|---|
| `casAtomic` | `false` — a directory has no compare-and-set |
| `serverWriteTime` | `true` — browser clock, with an optional uncertainty bound |
| `listPage` | ✓ — cursor-based pagination, envelopes included |
| `listVaults` | ✓ — top-level directories |
| `ping` | ✓ — one cheap touch of the root handle |

### This store never mints document numbers

`vault.sequence().next()` requires `casAtomic`. Because this store declares `false`, the hub
**refuses** the call rather than degrading it to a racy read-compare-write. That is the
intended outcome: sequence allocation stays on a CAS-capable primary store (typically
`to-browser-idb`), and the share only ever carries records that were already numbered. If
you are issuing receipts, bills, or certificates, allocate them on tier 1 — never here.

Ordinary `expectedVersion` writes *do* degrade to read-compare-write, with a TOCTOU window
that SMB client caching (oplocks and leases) widens. Concurrent writes to different records
are naturally safe — different files. The exposure concentrates in shared objects
(`_sequences`, manifests, `_periods`), which is exactly why they belong on the primary.

## Store locator

```ts
import { createStoreLocator } from '@noy-db/hub/to'
import { registerBrowserFsStore, browserFsStoreDescriptor } from '@noy-db/to-browser-fs'

const locator = createStoreLocator()
registerBrowserFsStore(locator)

const store = await locator.resolve(
  browserFsStoreDescriptor({ label: 'LAN' }),
  { binding: { handle: await recallDirectory('lan-share') } },
)
```

`kind: 'browser-fs'`, `class: 'lan'`. The descriptor is identity-only and carries no handle
— a directory handle cannot be reconstructed from JSON, so it must be recalled or re-picked
and passed as a binding.

## License

Apache-2.0
