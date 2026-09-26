# @noy-db/to-icloud

## 0.9.0-pre.0

Lockstep bump to the 0.9 line; **no package-level code change**. Exact dev pins on
`@noy-db/hub` and `@noy-db/ports` move `0.9.0-pre.1` → `0.9.0-pre.2`. The `@noy-db/hub`
peer range already carried `^0.9.0-pre.1` and needs no second append: for a 0.x caret npm
reads that as `>=0.9.0-pre.1 <0.10.0`, so it already admits `0.9.0` stable. `^0.9.0-pre.1`
rather than `-pre.0` is deliberate — `pre.0` carries core#132 (last-writer-wins `_keyring`
writes, `TamperedError` on a cold read) and nothing should resolve to it. Repo suite green at
the new pin: 86 test files / 1892 tests.

## 0.8.1

Lockstep bump to 0.8.1 for the `@noy-db/to-memory` relocation (family#17); no package-level code change. README licence section names Apache-2.0, matching the manifest and LICENSE.

## 0.8.0

Lockstep bump to 0.8.0; no package-level change in this release. See `@noy-db/hub` 0.8.0 for
the line's notes.

## 0.8.0-pre.0

Relicensed from MIT to Apache-2.0 from this version on. Earlier versions remain MIT.

Binds `@noy-db/hub@0.8.0-pre.0`.

### Compatibility

- Peer range on `@noy-db/hub` **widened by appending** `|| ^0.8.0-pre.0`. Every range
  admitted before is still admitted; nothing compels an upgrade.
- The suite runs against the **published** `@noy-db/hub@0.8.0-pre.0` and
  `@noy-db/test-adapter-conformance@0.8.0-pre.0` — the whole `@noy-db/*` dev-pin line
  moved as a unit.

### Licensing

- `LICENSE` (Apache-2.0) and `NOTICE` now ship in the tarball; both are listed in `files`.

## 0.7.0-pre.0

**First cut on the hub 0.7 line.**

### Compatibility

- **Peer range WIDENED by appending, not narrowed**: `^0.6.0-pre.0 || ^0.7.0-pre.0`
  (`^0.6.0-pre.11 || ^0.7.0-pre.0` for `to-drive`/`to-icloud`). A consumer on a `0.6.x` hub
  keeps it; nothing compels an upgrade. Verified by compiling every store against the
  **oldest** hub its range admits, at both declared floors — not just against the dev pin.
- The store imports **zero** symbols retired by hub 0.7's `Provider`-suffix removal
  (measured against the shipped codemod map, all `safeGlobalReplace` rows) — which is why
  widening rather than narrowing is honest here.

## 0.6.0

**First stable release of the extended storage adapters.**

### Compatibility

- **Peer range unchanged and unnarrowed**: `^0.6.0-pre.0`, and `^0.6.0-pre.11` for `to-drive`/`to-icloud`. Both already admitted `0.6.0`, so adopting this release requires no change on your side.
- Development pin moved to the stable `@noy-db/hub@0.6.0`. Every store was verified to compile against the **oldest** hub its declared range admits, not just against the pin.

### What a stable fixes for you

The `0.5.0` line was broken on arrival: those versions import `StoreLocator`, `StoreDescriptor` and `StoreFactory` while advertising a `^0.5.0` peer, and `@noy-db/hub@0.5.0` exports none of them. All 17 remain **deprecated on purpose** — they are immutable, and the deprecation is the only signal anyone pinning them will ever see.

Until now an untagged `npm i @noy-db/to-postgres @noy-db/hub` could not give you a working, current pair. From this release it can.

### Notes on the 0.6 line

Three no-migration format changes landed upstream during the pre-release line. **None of them affects the ciphertext a store holds** — the hub encrypts before any adapter is called and decrypts after it returns, so a format change is invisible across this seam by construction. A vault created before them must be re-seeded; that is a hub concern, and your store's data is not the thing at fault. See `README.md` — *What a passing test suite here does and does not prove*.

## 0.6.0-pre.7

### The peer-floor guard now runs on source changes

- **No functional change to this package.** Its `dist` is byte-identical to `0.6.0-pre.6`; this release carries a CI fix and exists to keep the registry in step with `main`.
- **`peer-floor.yml` was triggered on manifest edits only**, so a source change never ran it ([#104](https://github.com/vLannaAi/noy-db-to/pull/104)). A declared peer range becomes false in two ways, and the guard could see one: a manifest edit changes the range directly, while a source edit changes what the code *needs* — adopting a symbol the floor does not have. Both `pull_request` and `push` filters now include `to-*/src/**`.

  Measured across published tarballs, three symbols exist at the current dev pin and at **neither** declared floor — `RefNotDeclaredError`, `KeyringTamperedError` and `RecordRef`. A single `src/` import of any of them would falsify both ranges, compile cleanly against the dev pin, and pass every other gate.

- Peer ranges are unchanged: `^0.6.0-pre.0`, and `^0.6.0-pre.11` for `to-drive`/`to-icloud`. Verified true at both floors.

## 0.6.0-pre.6

### Hub dev pin moved to `0.6.0-pre.23`

- **The peer range is unchanged**, and that is the important part: `^0.6.0-pre.0` (`^0.6.0-pre.11` for `to-drive`/`to-icloud`). A consumer's floor is the peer range, never this package's dev pin.
- **Existing installs:** adding or upgrading `@noy-db/to-*` alone does **not** move your hub. If you are already on an earlier `0.6.0-pre`, you keep it, and you meet no format change.
- **Fresh installs differ.** npm auto-installs peers at the newest satisfying version, and `^0.6.0-pre.0` admits `0.6.0-pre.23` — so installing from nothing gets you the current hub. With no existing data that is a non-event.

  ```
  FRESH     npm i @noy-db/to-postgres@next                    -> hub 0.6.0-pre.23
  EXISTING  npm i @noy-db/hub@0.6.0-pre.16 ; then the store   -> hub 0.6.0-pre.16
  ```

- **No functional change to this package.** Its `dist` is byte-identical to `0.6.0-pre.5`; only the development pin and the repo's own docs moved.
- Every store was verified to compile against the oldest hub its declared range admits, at both distinct floors.

### The ciphertext this store holds is unaffected by the 0.6 format changes

Two format changes landed upstream between `0.6.0-pre.18` and `0.6.0-pre.23`, and they have opposite shapes. Neither is a defect in this package, and neither touches the bytes a store holds — a store never decrypts.

- `pre.18` bound record identity into the AEAD. Records written before it cannot be opened by `pre.18` or later.
- `pre.21` authenticated the keyring roster. This fails at **unlock**, not at a record read, and travels with the vault rather than the payload.

The AEAD scheme is byte-identical across `pre.18 … pre.23`, so records remain cross-readable within that range. See `README.md` — *What a passing test suite here does and does not prove*.

## 0.6.0-pre.5

### The release path refuses to route a pre-release to `@latest`

- **No functional change to this package.** Its `dist` is byte-identical to `0.6.0-pre.4`; this release carries a repo-level release-integrity guard.
- **Added the pre-release routing guard** ([#97](https://github.com/vLannaAi/noy-db-to/pull/97)). The npm dist-tag was routed entirely by the "Set as a pre-release" checkbox on the GitHub Release form, with nothing refusing a mismatch — so a forgotten tick would publish a pre-release to `@latest`, which is not self-healing (`npm dist-tag` is an account-changing write needing an interactive 2FA OTP, so CI can never repair it). `release.yml` now fails the release when a semver pre-release version is published from a Release not marked as a pre-release. Only that direction is blocked — a stable version on `@next` is recoverable and stays allowed.

  This repo needed it most and had it last: its `@latest` is already broken (all 17 `to-*@0.5.0` versions are deprecated), and a pre-release landing there would add a second, independent defect to the same tag. noy-db-ui, noy-db and klum-db adopted the guard earlier.

Peer range is unchanged: `^0.6.0-pre.0` (`^0.6.0-pre.11` for `to-drive`/`to-icloud`).

## 0.6.0-pre.4

### Release-integrity work — no change to published code

- **No functional change to this package.** Its `dist` is byte-identical to `0.6.0-pre.3`; this release carries repo-level release-integrity work and exists to bring the registry back in step with `main`.
- **The peer-floor guard now gates releases** ([#94](https://github.com/vLannaAi/noy-db-to/pull/94)). It was triggered only on `pull_request`/`push`, which a `release` event never matches — so a release could publish a peer range the guard would have rejected. It is now a `workflow_call` from `release.yml`, checked out at the release tag, and `publish` depends on it.
- **Three defects fixed in the guard's range analysis** ([#95](https://github.com/vLannaAi/noy-db-to/pull/95)). `semver.minVersion` throws on a malformed range, returns null on an unsatisfiable one, and floors an unbounded range (`*`, `x`, blank) at `0.0.0` — a version no `@noy-db` package has published. Only the null case was handled. All three now fail fast and name the package.
- **The docs-bridge store table is derived, not counted** ([#93](https://github.com/vLannaAi/noy-db-to/pull/93), [#94](https://github.com/vLannaAi/noy-db-to/pull/94)). A missing entry previously made the bridge throw while the release still reported success; the expected set is now read from the `to-*` directories, and a bridge failure writes a loud block to the run summary.

Peer range is unchanged: `^0.6.0-pre.0` (`^0.6.0-pre.11` for `to-drive`/`to-icloud`, which need a generic `StoreLocator.register()`).

## 0.6.0-pre.3

### Peer range narrowed to the versions that actually work ([#89](https://github.com/vLannaAi/noy-db-to/issues/89), [#90](https://github.com/vLannaAi/noy-db-to/pull/90))

- `peerDependencies["@noy-db/hub"]` → **`^0.6.0-pre.11`**, replacing `^0.4.0-pre.11 || ^0.5.0 || ^0.6.0-pre.0`. Two separate falsehoods were retired: `StoreDescriptor` / `StoreFactory` / `StoreLocator` only exist from `0.6.0-pre`, and — specific to the pod stores — registering a `NoydbPodStore` factory without a cast needs `StoreLocator.register()` to be **generic over both store shapes**, which landed in `0.6.0-pre.11`. `register()` existed before that; it simply could not accept the argument. Floor verified by compiling this package against it, not by probing symbol names.

  The family rule is *widen by appending*, which assumes compatibility only grows. It does not: adopting a symbol that exists only from a given upstream version silently retracts the older branches, and no gate notices. **Narrowing is the honest correction.**

### Migrated off the removed hub aliases ([#87](https://github.com/vLannaAi/noy-db-to/pull/87))

- `BundleVersionConflictError` → `PodVersionConflictError` in tests, and `wrapBundleStore()` → `wrapPodStore()` in the source doc comments — **which ship in the published `.d.ts`**, so this was not a tests-only migration. Downstream half of noy-db#1052.

### Hub 0.6.0-pre.16 adopted ([#87](https://github.com/vLannaAi/noy-db-to/pull/87), [#88](https://github.com/vLannaAi/noy-db-to/pull/88))

- Dev pins → `0.6.0-pre.16` for `@noy-db/hub` and `@noy-db/test-adapter-conformance`, moved as a **unit** — a hub-only bump leaves siblings behind and invites the tree to resolve two copies of the same lockstep line.

## 0.6.0-pre.2

### Hub 0.6.0-pre.11 adopted ([#83](https://github.com/vLannaAi/noy-db-to/pull/83))

- Dev pins → `0.6.0-pre.11` for `@noy-db/hub` and `@noy-db/test-adapter-conformance`. `peerDependencies` are **unchanged**: `^0.6.0-pre.0` already admits later pre-releases on the same `major.minor.patch`, so a same-line hub release does not force a rebuild on consumers. Eight hub releases landed since `pre.3` (pre.4, 5, 7, 8, 9, 10, 11 — pre.6 was never published) and **the store contract did not move**: `kernel/types` and `kernel/errors` are byte-identical between the two, and the hub's exports map neither gained nor lost a subpath. The `/to` seam gained `AnyNoydbStore`, `isPodStore()`, a generic `StoreFactory<S>` and `resolveAny()` — all additive. Full conformance re-validated.

### Registers without a cast ([#84](https://github.com/vLannaAi/noy-db-to/pull/84))

- `StoreLocator.register()` is generic over both store shapes since hub `0.6.0-pre.11` (noy-db#988), so this pod store no longer registers through `as unknown as StoreFactory`. The `NoydbPodStore` return is now inferred rather than asserted away — a double cast suppressed checking in both directions, so a future change to the factory's return type is now caught instead of swallowed. No runtime change.

## 0.6.0-pre.1

### Eviction docs corrected: modern macOS is dataless-in-place, not `.icloud` stubs ([#15](https://github.com/vLannaAi/noy-db-to/issues/15))

- Documentation only — **zero non-comment lines** in the source diff. Verified on macOS Sequoia (Darwin 24.6) against a genuine synced iCloud Drive folder: `brctl evict` writes **no** `.icloud` stub. The canonical file stays put and becomes APFS-dataless (`stat` reports full logical size, `du` reports 0 bytes), and a plain read blocks transparently while the OS rehydrates, then succeeds.
- So the stub-detection sequence never fires on current macOS — the store is functionally correct there via its ordinary read path, and the stub branch is the **legacy** shape, kept for older macOS and other sync surfaces. The package had described the stub as *the* eviction shape.
- Corrected across the module docblock (new *Eviction shapes* section), `isStub`, `stubAwareRead`, `readBundle`, `ICloudFs.triggerDownload`, the README (new comparison table), the package description, and `mockFs()`'s docblock — the mock simulates the legacy shape and was easy to mistake for a model of current macOS.
- The consequence for callers is **latency, not errors**: a read of an evicted bundle can block on the network with no advance signal. Telling evicted-dataless from locally-present needs an `st_blocks`-vs-logical-size comparison the duck-typed `ICloudFs` does not expose; left open and cross-referenced, not built.

### Descriptors may only set declared keys ([#69](https://github.com/vLannaAi/noy-db-to/issues/69))

- Every non-descriptor input here (`folder`, `fs`) is applied unconditionally, so nothing was shadowable — but the factory still spread the unchecked `options` bag. It now destructures the declared `suffix`, and a new `#69` test asserts the invariant, whose value is that it holds across all 17 stores rather than only where it happened to bite.

### Hub 0.6.0-pre.3 adopted ([#74](https://github.com/vLannaAi/noy-db-to/pull/74))

- Dev pins → `0.6.0-pre.3` for `@noy-db/hub` and `@noy-db/test-adapter-conformance`. `peerDependencies` are **unchanged**: the existing `^0.6.0-pre.0` already admits later pre-releases on the same `major.minor.patch`, which is the ranged peer doing its job — a same-line hub release must not force a rebuild on consumers. The `/to` store contract is unchanged (hub `pre.2` was comment-only; `pre.3` covers pod-write strictness, a barrel re-export, and a codemod asset). Full conformance re-validated.

## 0.5.0

### Store-locator descriptor adopted ([#58](https://github.com/vLannaAi/noy-db-to/issues/58))

- New `icloudStoreDescriptor()` / `icloudStoreFactory` / `registerIcloudStore()` (plus the `ICloudAddress`, `ICloudDescriptorOptions`, `ICloudBinding` types) — a credentialless, JSON-serializable `StoreDescriptor` (`kind: 'icloud'`, `class: 'local'`) reconstructs the store via `createStoreLocator()`. `address` is `{ folder }`: `folder` maps to `ICloudStoreOptions.folder` and is **required** — unlike the other stores in this tier, `toIcloud()` has no default and refuses to construct without it. `opts.binding.client` is required because this store does not construct its own filesystem facade; resolving without it throws a clear error naming the missing slot. `toIcloud()` returns a `NoydbPodStore`, not a `NoydbStore`, so `icloudStoreFactory`'s return type is deliberately unnarrowed — callers that need the six-method contract wrap the result with `wrapPodStore()` themselves.

## 0.4.0

### Hub 0.6.0-pre.1 adopted, conformance suite de-vendored ([#19](https://github.com/vLannaAi/noy-db-to/issues/19))

- `peerDependencies["@noy-db/hub"]` widened with `|| ^0.6.0-pre.0`; dev pin → `0.6.0-pre.1`. The `/to` store contract is unchanged.
- The adapter-conformance suite is no longer vendored in this repo — every store now runs the published `@noy-db/test-adapter-conformance`, so the store contract has one definition instead of two that could drift. Full conformance re-validated.


## 0.3.1

### Hub 0.5.0 stable adopted ([#52](https://github.com/vLannaAi/noy-db-to/issues/52))

- `peerDependencies["@noy-db/hub"]` → `^0.4.0-pre.11 || ^0.5.0`, dev pin → `0.5.0`. Full conformance re-validated against the published hub 0.5.0 stable (`@latest`); the `/to` store contract is unchanged. Hub 0.5.0 exports `isConflictError` from its root (noy-db#935), making the store-error identity contract (`name === 'ConflictError'`) load-bearing engine-side — this store already satisfies it via the shared error class.

### Hub peer floor raised to 0.4.0-pre.11 ([#30](https://github.com/vLannaAi/noy-db-to/issues/30))

- `peerDependencies["@noy-db/hub"]` → `^0.4.0-pre.11` (was `^0.3.0 || ^0.4.0`). This store conforms through the hub's `wrapPodStore()`, which lost concurrent writes and leaked internals in `loadAll()` until hub `0.4.0-pre.11` (noy-db#908) — verified the 0.3.x wrapper carries both defects, so the `^0.3.0` arm is dropped too. Machine-checkable floor instead of a README caveat; the other 14 stores keep `^0.3.0 || ^0.4.0`.

## 0.3.0

### Hub 0.4.0 stable adopted ([#38](https://github.com/vLannaAi/noy-db-to/issues/38))

- `peerDependencies["@noy-db/hub"]` → `^0.3.0 || ^0.4.0`, dev pin → `0.4.0`. Full conformance re-validated against the published hub 0.4.0 stable (`@latest`), whose `db.transaction(fn)` now genuinely delegates to `store.tx()` on `txAtomic` stores (noy-db#906).

## 0.3.0-pre.3

### Test-only: wired into the shared adapter-conformance suite ([#26](https://github.com/vLannaAi/noy-db-to/issues/26))

- No runtime changes — lockstep version bump. The store now runs the vendored `@noy-db/test-adapter-conformance` contract in CI. The store is a `NoydbPodStore`, so it conforms through the hub's `wrapPodStore()` — the wrapper defects this surfaced (internal-collection leak in `loadAll`, concurrent-`put()` last-writer-wins) were noy-db#908, fixed in `@noy-db/hub 0.4.0-pre.11`, which is now the dev-test pin (peer range unchanged).

## 0.3.0-pre.1

### BREAKING: factory renamed to `toIcloud()` ([#18](https://github.com/vLannaAi/noy-db-to/pull/18))

- `icloud()` → `toIcloud()` — every extended store now exports a `to<Backend>()`-named factory matching the package-prefix grammar. Import sites change; options and behavior are identical.

### Hub 0.4.0 pre line adopted ([#20](https://github.com/vLannaAi/noy-db-to/issues/20))

- `peerDependencies["@noy-db/hub"]` → `^0.3.0 || ^0.4.0-pre.10`, dev pin → `0.4.0-pre.10`. The `@noy-db/hub/to` store contract is byte-identical between hub `0.3.0` and `0.4.0-pre.10` (seam types and runtime verified), so the range spans both lines; the full suite runs against `0.4.0-pre.10`.

## 0.2.0

### Hub floor normalized to the first stable

- `peerDependencies["@noy-db/hub"]` → `^0.3.0`, dev pin → `0.3.0` (noy-db's first stable on `@latest`). No adapter code changes: the 0.3.0 store-contract deltas (`_del` envelope field, `/adapter`→`/to` retirement, `StoreCredentials` seam) were adopted during the 0.3.0-pre line; this release re-validates the full conformance suite against the published stable.

## 0.2.0-pre.5

Version-only lockstep bump; no source changes since pre.4.

## 0.2.0-pre.4

Version-only lockstep bump; no source changes since pre.3.

## 0.2.0-pre.3

Version-only lockstep bump; no source changes since pre.2.

## 0.2.0-pre.2

### Patch Changes

- Updated dependencies
  - @noy-db/hub@0.2.0-pre.2

## 0.2.0-pre.1

### Patch Changes

- Updated dependencies
  - @noy-db/hub@0.2.0-pre.1

## 0.1.0-pre.16

### Patch Changes

- Updated dependencies
  - @noy-db/hub@0.1.0-pre.16

## 0.1.0-pre.15

### Patch Changes

- Updated dependencies
  - @noy-db/hub@0.1.0-pre.15
## 0.1.0-pre.14

### Patch Changes

- Updated dependencies
  - @noy-db/hub@0.1.0-pre.14

## 0.1.0-pre.12

### Patch Changes

- Updated dependencies
  - @noy-db/hub@0.1.0-pre.12


## 0.1.0-pre.11

### Patch Changes

- Updated dependencies
  - @noy-db/hub@0.1.0-pre.11


## 0.1.0-pre.9

### Patch Changes

- Updated dependencies — @noy-db/hub@0.1.0-pre.9


## 0.1.0-pre.8

### Patch Changes

- Updated dependencies — @noy-db/hub@0.1.0-pre.8

## 0.1.0-pre.7

### Patch Changes

- Updated dependencies
  - @noy-db/hub@0.1.0

## 1.0.0

### Patch Changes

- # v0.1.0-pre.6 — Per-principal user envelope + pilot-1 client-API unblockers

  ## Per-principal user envelope (`vault.user.*`)

  Every keyring in a vault now gets its own `_users/<keyringId>` envelope, encrypted under a vault-shared `_users` DEK. Hub owns the plumbing (storage, sync, history, lifecycle, encryption, policy gates); apps own the schema. The reference shape lives in the showcase and recipe as copy-paste material — `import { type UserShape } from '@noy-db/hub'` is intentionally NOT a thing.

  ### New API on every Vault

  ```ts
  // Write-self — own keyringId only (own-only write rule, structural)
  vault.user.me<T>(): Promise<UserEnvelope<T> | null>
  vault.user.updateMe<T>(patch: DeepPartial<T>, presented?): Promise<UserEnvelope<T>>
  vault.user.setMe<T>(payload: T, presented?): Promise<UserEnvelope<T>>

  // Read-anyone — gated by view-team-profiles (default minTier: 2)
  vault.user.get<T>(keyringId, presented?): Promise<UserEnvelope<T> | null>
  vault.user.list<T>(presented?): Promise<UserEnvelope<T>[]>

  // Reactive — fires on local writes
  vault.user.subscribe<T>(keyringId, cb): Unsubscribe
  vault.user.live<T>(keyringId): LiveUserEnvelope<T>
  ```

  ### New built-in policy gates

  | Gate                 | PERSONAL_POLICY  | STRICT_POLICY                                    |
  | -------------------- | ---------------- | ------------------------------------------------ |
  | `edit-own-profile`   | `{ minTier: 3 }` | `{ minTier: 2, factors: [{ anyOf: ['totp'] }] }` |
  | `view-team-profiles` | `{ minTier: 2 }` | `{ minTier: 2 }`                                 |

  `view-team-profiles.enabled: false` is the privacy-strict opt-out — `vault.user.list()` silently returns `[me]` only; `vault.user.get(other)` throws `PolicyDeniedError`. The own-only write rule is structural — no policy can relax it.

  ### New on `db.grant()`

  `initialProfile?: T` — admin pre-fill for the new principal's first envelope, seeded under the caller's `_users` DEK. Once the user activates, the own-only rule prevents further admin edits. Bootstrap-only.

  ### New on `team/keyring.ts`

  `listUsersWithEnvelopes<T>(adapter, vault, dek)` — joined enumeration of keyrings + their envelopes. Convenience for admin UIs.

  ### Lifecycle binding

  - `createOwnerKeyring()` eager-provisions the `_users` DEK at vault creation; every subsequent `grant()` propagates it via the existing system-collection branch.
  - `revoke()` cascade-deletes the principal's envelope alongside the keyring.
  - DEK rotation re-encrypts every `_users/*` envelope under the fresh DEK (free, since `_users` is in the affected collections set).

  ## Client-API unblockers for pilot-1

  ### `db.enrollWebAuthn(vault, ceremony, presented?)`

  Native WebAuthn enrollment using the **real** internal keyring. Unblocks `pilot-1#31`. The ceremony callback receives the live `UnlockedKeyring` so the `wrapped_kek` references the live KEK (not a synthetic app-layer payload that fails at unlock time). Hub does not import `@noy-db/on-webauthn` (would invert dep graph); consumers wire the on-webauthn `enrollWebAuthn` function in via the ceremony callback.

  ### `db.listWebAuthnSlots(vault)`

  Filter the slot list to webauthn-method slots only. Returns `id`, `enrolledAt`, `credentialId` — useful for "you have N WebAuthn credentials" UI surfaces and `allowCredentials` lookups.

  ### `db.lockVault(vault)`

  Soft-lock that scrubs `keyringCache`, `vaultCache`, `activeTier`, `syncEngines`, `policyEnforcers` for the vault — but preserves `quickUnlock` (PIN resume after lock-screen UX) and `policyCache` (on-disk policy survives lock). Idempotent; the `Noydb` instance remains usable. Unblocks `pilot-1#33`.

  ## Forward-compat (documented, not exported in v1)

  The `UserProfileProvider` interface is documented in `docs/subsystems/user-envelope.md` and `docs/superpowers/specs/2026-05-05-user-envelope-design.md`. Implementation lands post-1.0 alongside managed-passphrase mode (#14).

  ## Documentation

  - `docs/subsystems/user-envelope.md` — full subsystem reference
  - `docs/recipes/user-preferences.md` — reference shape pattern
  - `showcases/src/70-user-envelope.showcase.test.ts` — Hub API end-to-end (vitest)
  - `showcases/src/recipe-user-preferences.recipe.test.ts` — runnable recipe (vitest)
  - `features.yaml` — registered (validates clean: 26 features, 6 recipes)

  ## Tests

  - 41 new user-envelope tests (storage, API, lifecycle, gates, team integration)
  - 6 new enroll-webauthn tests
  - 7 new lock-vault tests
  - Hub suite: 1297/1297 green. Full repo: 2338/2338 green.

  ## Breaking changes

  None. All additions are additive; default behavior of pre-existing vaults is unchanged. Pre-existing vaults have a documented one-time DEK-rotate workflow when adopting `vault.user.*` for multi-principal reads (see "Edge cases & limits" in `docs/subsystems/user-envelope.md`).

  ## Issues closed

  - #16 — feat(hub): db.enrollWebAuthn() — native WebAuthn enrollment using real keyring
  - #17 — feat(hub): db.lockVault() — soft lock that clears DEKs without destroying the instance
  - #18 — feat(hub): \_meta/user/<keyringId> envelope storage primitive
  - #19 — feat(hub): vault.user.\* API surface + own-only write rule
  - #20 — feat(hub): keyring lifecycle binding for user envelope (grant/revoke + initialProfile)
  - #21 — feat(hub): magic-link grant — initialProfile bootstrap (closed as scope-corrected; covered by #20 via GrantOptions.initialProfile on the regular grant path; team/magic-link-grant.ts is tier delegation, not user creation)
  - #22 — feat(hub): policy gates edit-own-profile + view-team-profiles
  - #23 — feat(hub): team integration — listKeyringsWithUsers() + presence displayName
  - #24 — showcase: 70-user-envelope + recipe-user-preferences (vitest)
  - #25 — docs(user-envelope): subsystem doc + SUBSYSTEMS.md anchor + features.yaml registry

- Updated dependencies
  - @noy-db/hub@0.1.0
