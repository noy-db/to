# Changelog — to-browser-local


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

- `peerDependencies["@noy-db/hub"]` → **`^0.6.0-pre.0`**, replacing `^0.3.0 || ^0.4.0 || ^0.5.0 || ^0.6.0-pre.0`. The old range was a false promise: `StoreDescriptor`, `StoreFactory` and `StoreLocator` exist on `@noy-db/hub/to` only from `0.6.0-pre`, so `npm i` with an older hub satisfied the peer check and then failed to typecheck. The new floor was verified by compiling this package's `src/` against it.

  The family rule is *widen by appending*, which assumes compatibility only grows. It does not: adopting a symbol that exists only from a given upstream version silently retracts the older branches, and no gate notices. **Narrowing is the honest correction.**

### Hub 0.6.0-pre.16 adopted ([#87](https://github.com/vLannaAi/noy-db-to/pull/87), [#88](https://github.com/vLannaAi/noy-db-to/pull/88))

- Dev pins → `0.6.0-pre.16` for `@noy-db/hub` and `@noy-db/test-adapter-conformance`, moved as a **unit** — a hub-only bump leaves siblings behind and invites the tree to resolve two copies of the same lockstep line.

## 0.6.0-pre.2

### Hub 0.6.0-pre.11 adopted ([#83](https://github.com/vLannaAi/noy-db-to/pull/83))

- Dev pins → `0.6.0-pre.11` for `@noy-db/hub` and `@noy-db/test-adapter-conformance`. `peerDependencies` are **unchanged**: `^0.6.0-pre.0` already admits later pre-releases on the same `major.minor.patch`, so a same-line hub release does not force a rebuild on consumers. Eight hub releases landed since `pre.3` (pre.4, 5, 7, 8, 9, 10, 11 — pre.6 was never published) and **the store contract did not move**: `kernel/types` and `kernel/errors` are byte-identical between the two, and the hub's exports map neither gained nor lost a subpath. The `/to` seam gained `AnyNoydbStore`, `isPodStore()`, a generic `StoreFactory<S>` and `resolveAny()` — all additive. Full conformance re-validated.

## 0.6.0-pre.1

### Descriptors may only set declared keys ([#69](https://github.com/vLannaAi/noy-db-to/issues/69))

- `to-browser-local` descriptors can no longer set anything the store's `DescriptorOptions` / `Address` types declare no field for. The factory destructures named fields instead of spreading the descriptor's unchecked `options` (and, where applicable, `address`) bag into the store options. Where the winning key was applied *conditionally*, a matching key in that bag previously survived and won — here: `prefix` — the factory spread `{ ...address, ...options }`, so an `options` key beat the same key in `address`. New `#69` tests assert an undeclared key cannot reach the store.

### Hub 0.6.0-pre.3 adopted ([#74](https://github.com/vLannaAi/noy-db-to/pull/74))

- Dev pins → `0.6.0-pre.3` for `@noy-db/hub` and `@noy-db/test-adapter-conformance`. `peerDependencies` are **unchanged**: the existing `^0.6.0-pre.0` already admits later pre-releases on the same `major.minor.patch`, which is the ranged peer doing its job — a same-line hub release must not force a rebuild on consumers. The `/to` store contract is unchanged (hub `pre.2` was comment-only; `pre.3` covers pod-write strictness, a barrel re-export, and a codemod asset). Full conformance re-validated.

## 0.5.0

### Store-locator descriptor adopted ([#58](https://github.com/vLannaAi/noy-db-to/issues/58), noy-db#945)

- New `browserLocalStoreDescriptor()` / `browserLocalStoreFactory` / `registerBrowserLocalStore()` — a credentialless, JSON-serializable `StoreDescriptor` (`kind: 'browser-local'`, `class: 'browser'`) reconstructs the store via `createStoreLocator()`. The simplest citizen of the tier: `localStorage` needs no credentials and no transport, so both the `binding` and `credentials` slots are ignored at resolve time; `address` is `{ prefix? }` and `options` carries `{ obfuscate?, clockUncertaintyMs? }`. Verified by a descriptor→resolve→full-conformance round-trip, plus a behavioural check that a descriptor's `obfuscate: true` really reaches the store (the resolved store's `localStorage` keys are hashed).

## 0.4.0

### Hub 0.6.0-pre.1 adopted, conformance suite de-vendored ([#19](https://github.com/vLannaAi/noy-db-to/issues/19))

- `peerDependencies["@noy-db/hub"]` widened with `|| ^0.6.0-pre.0`; dev pin → `0.6.0-pre.1`. The `/to` store contract is unchanged.
- The adapter-conformance suite is no longer vendored in this repo — every store now runs the published `@noy-db/test-adapter-conformance`, so the store contract has one definition instead of two that could drift. Full conformance re-validated.


## 0.3.1

### Hub 0.5.0 stable adopted ([#52](https://github.com/vLannaAi/noy-db-to/issues/52))

- `peerDependencies["@noy-db/hub"]` → `^0.3.0 || ^0.4.0 || ^0.5.0`, dev pin → `0.5.0`. Full conformance re-validated against the published hub 0.5.0 stable (`@latest`); the `/to` store contract is unchanged. Hub 0.5.0 exports `isConflictError` from its root (noy-db#935), making the store-error identity contract (`name === 'ConflictError'`) load-bearing engine-side — this store already satisfies it via the shared error class.

## 0.3.0

### Hub 0.4.0 stable adopted ([#38](https://github.com/vLannaAi/noy-db-to/issues/38))

- `peerDependencies["@noy-db/hub"]` → `^0.3.0 || ^0.4.0`, dev pin → `0.4.0`. Full conformance re-validated against the published hub 0.4.0 stable (`@latest`), whose `db.transaction(fn)` now genuinely delegates to `store.tx()` on `txAtomic` stores (noy-db#906).

## 0.3.0-pre.3

### Test-only: wired into the shared adapter-conformance suite ([#26](https://github.com/vLannaAi/noy-db-to/issues/26))

- No runtime changes — lockstep version bump. The store now runs the vendored `@noy-db/test-adapter-conformance` contract in CI.

## 0.3.0-pre.1

### BREAKING: factory renamed to `toBrowserLocal()` ([#18](https://github.com/vLannaAi/noy-db-to/pull/18))

- `browserLocalStore()` → `toBrowserLocal()` — every extended store now exports a `to<Backend>()`-named factory matching the package-prefix grammar. Import sites change; options and behavior are identical.

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

## 0.1.0-pre.1 — Initial pre-release
