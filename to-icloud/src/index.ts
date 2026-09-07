/**
 * **@noy-db/to-icloud** — iCloud Drive bundle store for noy-db.
 *
 * Treats each vault as a single `.noydb` bundle stored under
 * `~/Library/Mobile Documents/…` (or any user-chosen iCloud path).
 * Pair with `wrapPodStore()` from `@noy-db/hub` to get the
 * standard six-method `NoydbStore` surface.
 *
 * ## Why a dedicated package if `to-file` "works"?
 *
 * `@noy-db/to-file` pointed at an iCloud Drive directory technically
 * works — until one of three iCloud-specific behaviors bites you:
 *
 *   1. **On-demand eviction.** iCloud may evict a file's contents to
 *      cloud-only storage. Two shapes, and which one you get depends on
 *      the macOS version — see *Eviction shapes* below. This store
 *      handles both: the ordinary read path covers modern dataless
 *      eviction, and an explicit stub branch covers the legacy shape.
 *   2. **Conflict files.** Parallel writes from two devices create
 *      `name (device conflicted copy DATE).noydb`. This store detects
 *      those files and raises `PodVersionConflictError`, giving the
 *      caller a chance to merge deliberately.
 *   3. **Sync-not-yet-complete writes.** A completed `writeFile()` does
 *      not mean the bytes are on Apple's servers. `ping()` reports
 *      on upload status so callers can wait before considering a
 *      write durable.
 *
 * ## Eviction shapes — dataless (modern) vs. `.icloud` stub (legacy)
 *
 * Observed on macOS Sequoia (Darwin 24.6) against a genuine synced
 * iCloud Drive folder, after `brctl evict` on a fully-uploaded file:
 *
 * - **No `.name.icloud` stub is created.** The canonical file stays
 *   exactly where it was.
 * - It becomes **APFS-dataless**: `stat`/`ls` keep reporting the full
 *   logical size while `du` reports 0 bytes actually on disk.
 * - A plain `read()` **blocks transparently** while the kernel and
 *   `fileproviderd` rehydrate the content, then succeeds. For a 195 KB
 *   bundle that was ~0.7 s.
 *
 * So on current macOS the stub-detection sequence below (`stat(path)` →
 * null → `stat(path + '.icloud')` → `triggerDownload`) **never fires**:
 * `stat(path)` succeeds and the ordinary read just works. The store is
 * functionally correct there via its normal path, and the stub branch is
 * the *legacy* shape — older macOS, and other sync surfaces that still
 * materialise a separate stub file. It is kept for exactly that reason,
 * not because it is the common case.
 *
 * The practical consequence for callers is latency, not errors: a read
 * of an evicted bundle can block on the network with no signal that it
 * is about to. Distinguishing evicted-dataless from locally-present
 * needs a `st_blocks`-vs-logical-size comparison, which this store's
 * duck-typed `ICloudFs` does not currently expose — see #15.
 *
 * ## Scope
 *
 * - **Node (macOS) only for v1.** Browser / iOS consumers go through
 *   CloudKit JS — a separate package will ship as `@noy-db/to-cloudkit`.
 * - **Bundle granularity** — whole vault in one file. Pair with
 *   `syncPolicy: { push: { mode: 'debounce', 30_000 } }` so every
 *   record mutation doesn't trigger a full bundle upload.
 * - **No extra auth** — iCloud syncs via the user's signed-in Apple ID;
 *   the store never sees credentials.
 *
 * @packageDocumentation
 */

import type { NoydbPodStore, StoreDescriptor, StoreLocator } from '@noy-db/hub/to'
import { PodVersionConflictError } from '@noy-db/hub/to'

/** Default iCloud Drive folder name inside a user's mobile-documents tree. */
export const DEFAULT_FOLDER = 'NoyDB'

export interface ICloudFs {
  readFile(path: string): Promise<Uint8Array | Buffer | null>
  writeFile(path: string, data: Uint8Array): Promise<void>
  unlink(path: string): Promise<void>
  readdir(path: string): Promise<string[]>
  stat(path: string): Promise<{ mtimeMs: number; size: number } | null>
  /**
   * macOS-only: force iCloud to materialise a LEGACY `.icloud` stub.
   * Unused on modern macOS, where eviction is dataless-in-place and a
   * plain `readFile` rehydrates transparently (#15).
   */
  triggerDownload?(path: string): Promise<void>
}

export interface ICloudStoreOptions {
  /** Absolute path to the iCloud Drive folder that holds bundles. */
  readonly folder: string
  /** File-system facade — swap in a mock or a cross-platform shim. */
  readonly fs: ICloudFs
  /** Bundle filename suffix. Default `'.noydb'`. */
  readonly suffix?: string
}

function fileName(vault: string, suffix: string): string {
  return `${vault}${suffix}`
}

function isStub(name: string): boolean {
  // The LEGACY offload shape: a separate `<name>.icloud` placeholder file.
  // Modern macOS (verified on Darwin 24.6) does not write one — it makes
  // the canonical file APFS-dataless in place, so this never matches there.
  // Kept for older macOS and other sync surfaces. See the Eviction shapes
  // section in the module docblock.
  return name.endsWith('.icloud')
}

function isConflictCopy(name: string, expected: string): boolean {
  // Canonical shape: `foo (device conflicted copy DATE).noydb`
  return name.includes("'s conflicted copy") ||
         (name.includes('(conflicted copy') && name.endsWith(expected.slice(expected.lastIndexOf('.'))))
}

/**
 * Build a `NoydbPodStore` over an iCloud Drive folder. Wrap with
 * `wrapPodStore()` to consume via `createNoydb({ store })`.
 */
export function toIcloud(options: ICloudStoreOptions): NoydbPodStore {
  const suffix = options.suffix ?? '.noydb'
  const dir = options.folder.replace(/\/+$/, '')
  const { fs } = options

  async function pathFor(vault: string): Promise<string> {
    return `${dir}/${fileName(vault, suffix)}`
  }

  async function stubAwareRead(path: string): Promise<Uint8Array | null> {
    // Direct read first. On modern macOS this is also the EVICTION path:
    // an evicted bundle is dataless-in-place, so the read succeeds after
    // blocking for rehydration and nothing below ever runs. The cost is
    // latency, not failure.
    let bytes = await fs.readFile(path)
    if (bytes !== null) return bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)

    // Legacy shape only: an adjacent `.icloud` placeholder to materialise.
    const stubPath = `${path}.icloud`
    const stubExists = await fs.stat(stubPath)
    if (!stubExists) return null
    if (fs.triggerDownload) {
      await fs.triggerDownload(stubPath)
      bytes = await fs.readFile(path)
      if (bytes !== null) return bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)
    }
    // Still offloaded. Surface a clean error so the caller can retry
    // or invite the user to open iCloud.
    throw new Error(
      `iCloud file "${path}" is offloaded. Open the file in Finder to trigger a download, ` +
      `or install an OS-level trigger (\`brctl download "${path}"\`).`,
    )
  }

  async function detectConflict(vault: string): Promise<string | null> {
    const target = fileName(vault, suffix)
    const entries = await fs.readdir(dir).catch(() => [] as string[])
    for (const entry of entries) {
      if (isConflictCopy(entry, target)) return entry
    }
    return null
  }

  function versionOf(stat: { mtimeMs: number; size: number }): string {
    // mtime-based opaque token — sufficient for OCC within a single
    // syncing agent. iCloud's native conflict file machinery provides
    // the cross-agent guard.
    return `${stat.mtimeMs}-${stat.size}`
  }

  return {
    kind: 'bundle',
    name: 'icloud',

    async readBundle(vaultId) {
      const path = await pathFor(vaultId)
      const stat = await fs.stat(path)
      if (!stat) {
        // No canonical file. On modern macOS an evicted bundle still
        // stats fine (dataless-in-place), so reaching here means the
        // bundle is genuinely absent OR this is a legacy-stub surface.
        // Check for the stub before concluding "missing".
        const stubStat = await fs.stat(`${path}.icloud`)
        if (!stubStat) return null
        const bytes = await stubAwareRead(path)
        if (!bytes) return null
        const redoStat = await fs.stat(path)
        if (!redoStat) throw new Error(`icloud: file vanished after download at ${path}`)
        return { bytes, version: versionOf(redoStat) }
      }
      const bytes = await stubAwareRead(path)
      if (!bytes) return null
      return { bytes, version: versionOf(stat) }
    },

    async writeBundle(vaultId, bytes, expectedVersion) {
      // Conflict file present → refuse; caller merges.
      const conflict = await detectConflict(vaultId)
      if (conflict) {
        throw new PodVersionConflictError(
          `iCloud conflict file detected alongside "${vaultId}${suffix}": "${conflict}". ` +
          `Open iCloud Drive, resolve the conflict, then retry.`,
        )
      }
      const path = await pathFor(vaultId)
      const stat = await fs.stat(path)
      const current = stat ? versionOf(stat) : null
      if (expectedVersion !== null && current !== null && expectedVersion !== current) {
        throw new PodVersionConflictError(
          `iCloud bundle version mismatch: expected ${expectedVersion}, found ${current}`,
        )
      }
      await fs.writeFile(path, bytes)
      const newStat = await fs.stat(path)
      if (!newStat) throw new Error(`icloud: write reported success but stat failed at ${path}`)
      return { version: versionOf(newStat) }
    },

    async deleteBundle(vaultId) {
      const path = await pathFor(vaultId)
      try {
        await fs.unlink(path)
      } catch {
        // Idempotent
      }
    },

    async listBundles() {
      const entries = await fs.readdir(dir).catch(() => [] as string[])
      const out: Array<{ vaultId: string; version: string; size: number }> = []
      for (const entry of entries) {
        if (!entry.endsWith(suffix) || isStub(entry)) continue
        const vaultId = entry.slice(0, -suffix.length)
        const stat = await fs.stat(`${dir}/${entry}`)
        if (!stat) continue
        out.push({ vaultId, version: versionOf(stat), size: stat.size })
      }
      return out
    },
  }
}

/**
 * Wire a Node `fs/promises` implementation as an `ICloudFs`. Dynamic
 * import keeps the package browser-loadable (the caller's bundler
 * prunes the Node path).
 */
export async function nodeFs(): Promise<ICloudFs> {
  const fs = await import('node:fs/promises')
  const { spawn } = await import('node:child_process')
  return {
    async readFile(path) {
      try {
        return await fs.readFile(path)
      } catch {
        return null
      }
    },
    async writeFile(path, data) {
      await fs.writeFile(path, data)
    },
    async unlink(path) {
      await fs.unlink(path).catch(() => undefined)
    },
    async readdir(path) {
      return fs.readdir(path)
    },
    async stat(path) {
      try {
        const s = await fs.stat(path)
        return { mtimeMs: s.mtimeMs, size: s.size }
      } catch {
        return null
      }
    },
    async triggerDownload(path) {
      // macOS: `brctl download` forces iCloud to materialise a stub.
      await new Promise<void>((resolve) => {
        const child = spawn('brctl', ['download', path.replace(/\.icloud$/, '')])
        child.on('close', () => resolve())
        child.on('error', () => resolve())
      })
    },
  }
}

// ─── Store-locator descriptor (#58 — `local` class, opaque-client tier) ──

/**
 * Serializable location of an iCloud store. `folder` is REQUIRED — unlike
 * the other stores in this tier, `toIcloud()` has no default and refuses
 * to construct without it.
 */
export interface ICloudAddress {
  /** Maps to `ICloudStoreOptions.folder`. Required — `toIcloud()` has no default. */
  readonly folder: string
}

/** Serializable tuning carried on the descriptor (never credentials). */
export interface ICloudDescriptorOptions {
  readonly suffix?: string
}

/**
 * Device-local supplement resolved at `resolve()` time — the live
 * `ICloudFs` this store has no way to construct itself. Never serialized
 * into a pod alongside the descriptor.
 */
export interface ICloudBinding {
  readonly client: ICloudFs
}

/**
 * Builds the `StoreDescriptor` form of a `toIcloud()` store:
 * `kind: 'icloud'`, `class: 'local'`, with the identity address and the
 * serializable tuning as `options`. Credentialless by construction — the
 * live filesystem facade arrives via `binding.client` at `resolve()` time.
 */
export function icloudStoreDescriptor(address: ICloudAddress, options?: ICloudDescriptorOptions): StoreDescriptor {
  return { kind: 'icloud', class: 'local', address, ...(options !== undefined && { options }) }
}

/**
 * Reconstructs the same store `toIcloud()` builds, from a descriptor
 * produced by {@link icloudStoreDescriptor}. `opts.binding.client` is
 * required — this store has no client library of its own and cannot build
 * a filesystem facade from `address` alone.
 *
 * `toIcloud()` returns a `NoydbPodStore`, not a `NoydbStore` — this
 * factory's return type is deliberately NOT narrowed to match the hub's
 * generic `StoreFactory` shape. Callers that need the six-method contract
 * wrap the result with `wrapPodStore()` themselves, exactly as this
 * package's own tests do for `toIcloud()` directly.
 */
export function icloudStoreFactory(
  descriptor: StoreDescriptor,
  opts: { binding?: unknown },
): NoydbPodStore {
  const address = descriptor.address as ICloudAddress
  const { suffix } = (descriptor.options ?? {}) as ICloudDescriptorOptions
  const binding = (opts.binding ?? {}) as Partial<ICloudBinding>
  if (!binding.client) {
    throw new Error(
      '@noy-db/to-icloud: resolving this descriptor requires `binding.client` — ' +
      'this store does not construct its own connection. ' +
      'Pass one: locator.resolve(descriptor, { binding: { client } }).',
    )
  }
  return toIcloud({
    ...(suffix !== undefined && { suffix }),
    folder: address.folder,
    fs: binding.client,
  })
}

/**
 * Registers {@link icloudStoreFactory} under the `'icloud'` kind on
 * `locator`. No cast since hub `0.6.0-pre.11`: `register()` is generic over
 * both store shapes (noy-db#988), so the pod store's `NoydbPodStore` return
 * is inferred rather than asserted away. Callers resolving a descriptor
 * whose kind is not statically known should use `resolveAny()` +
 * `isPodStore()`.
 */
export function registerIcloudStore(locator: StoreLocator): void {
  locator.register('icloud', icloudStoreFactory)
}
