/**
 * **@noy-db/to-nfs** — NFS network-filesystem store for noy-db.
 *
 * NFS authentication is handled entirely outside noy-db (`AUTH_SYS`
 * UID/GID or Kerberos via `kinit`). This package wraps a self-contained
 * file-backed store with **NFS-specific pre-flight checks** — the kind
 * of thing that silently corrupts a store when ignored:
 *
 *   1. **`nolock` mount option** disables POSIX file locks. Silent
 *      concurrent-write corruption follows. We parse `/proc/mounts`
 *      (Linux) and throw (or warn) when the flag is active.
 *   2. **Attribute caching (`noac` absent)** — stale `mtime` / size
 *      cached by the client can let a version check pass on data
 *      that's already advanced on the server.
 *   3. **Wrong filesystem type** — the mount may silently be ext4
 *      (e.g. pointing at the wrong path). We confirm `statfs.type` is
 *      one of the NFS families.
 *
 * When running on non-Linux (macOS), `/proc/mounts` is absent so the
 * checks degrade to a warning. The store still functions — it simply
 * cannot self-diagnose the mount state.
 *
 * ## Not included
 *
 * - Native NFS client. noy-db works against a **pre-mounted** NFS
 *   path; use `mount.nfs4` / `/etc/fstab` as usual.
 * - Kerberos ticket management. `kinit` is the user's responsibility.
 *   The store surfaces `EKEYEXPIRED` as a clear error.
 *
 * @packageDocumentation
 */

import type { NoydbStore, StoreDescriptor, StoreFactory, StoreLocator } from '@noy-db/hub/to'
import { jsonFile } from './internal-file-store.js'

export interface NfsStoreOptions {
  /** Pre-mounted NFS directory. Fails fast if absent. */
  readonly mountPath: string
  /**
   * On detection of `nolock`, behavior is `'warn'` (default) or
   * `'error'`. Silent is not an option — NFS is tricky enough.
   */
  readonly onNolock?: 'warn' | 'error'
  /** Override the mount detector — injection seam for tests. */
  readonly mountDetector?: MountDetector
  /**
   * Logical NFS server this store believes it is talking to. Supply with
   * {@link NfsStoreOptions.export} to cross-check the claim against the
   * device the mount actually came from (#70). Both halves are required —
   * a half-stated identity is not checkable.
   */
  readonly server?: string
  /** Logical NFS export path. See {@link NfsStoreOptions.server}. */
  readonly export?: string
  /**
   * On a `server:/export` ↔ mounted-device mismatch, behavior is `'warn'`
   * (default) or `'error'`. Mirrors {@link NfsStoreOptions.onNolock}, and
   * defaults to warn for the same reason: an existing consumer whose
   * descriptor is merely imprecise must not break on upgrade.
   */
  readonly onDeviceMismatch?: 'warn' | 'error'
}

export interface MountInfo {
  readonly exists: boolean
  /**
   * The mount's device string — `server:/export` for an NFS mount,
   * `/dev/...` for a local one. `parts[0]` of the `/proc/mounts` line.
   * Absent when the detector cannot determine it.
   */
  readonly device?: string
  readonly fstype?: string
  readonly options?: readonly string[]
}

export type MountDetector = (mountPath: string) => Promise<MountInfo>

/**
 * Default mount detector — parses `/proc/mounts` on Linux. Returns
 * `{ exists: false }` on non-Linux or when the path isn't listed.
 */
export async function detectMount(mountPath: string): Promise<MountInfo> {
  try {
    const { readFile } = await import('node:fs/promises')
    const contents = await readFile('/proc/mounts', 'utf-8').catch(() => null)
    if (!contents) return { exists: false }
    const normalized = mountPath.replace(/\/+$/, '')
    for (const line of contents.split('\n')) {
      const parts = line.split(/\s+/)
      if (parts.length < 4) continue
      const [device, mp, fstype, optsStr] = parts
      if (mp === normalized) {
        return {
          exists: true,
          device: device!,
          fstype: fstype!,
          options: optsStr!.split(','),
        }
      }
    }
    return { exists: false }
  } catch {
    return { exists: false }
  }
}

const NFS_FSTYPES = new Set(['nfs', 'nfs4', 'nfs3'])

/**
 * Canonical form of a `server:/export` device string for comparison.
 * Only trailing slashes on the export are normalized away — `/exports/v`
 * and `/exports/v/` are the same export. Host case is left alone: the
 * comparison is a diagnostic, and silently equating hosts that differ only
 * in case would be a guess about DNS this store has no business making.
 */
function canonicalDevice(device: string): string {
  return device.replace(/\/+$/, '')
}

/** Marks the device-mismatch risk so severity handling can find its own message. */
const DEVICE_MISMATCH_PREFIX = 'Mount device mismatch:'
/** Marks the nolock risk for the same reason. */
const NOLOCK_MARKER = '`nolock`'

/**
 * Synchronous diagnostics run at store construction. Returns a list of
 * risk strings; empty = clean mount. Exposed so the consumer can log
 * or ship the report to an observability stack.
 */
export async function runMountDiagnostics(
  options: NfsStoreOptions,
): Promise<{ risks: string[]; info: MountInfo }> {
  const detector = options.mountDetector ?? detectMount
  const info = await detector(options.mountPath)
  const risks: string[] = []

  if (!info.exists) {
    risks.push(
      `Path "${options.mountPath}" is not listed in /proc/mounts. ` +
      `Either the path is not mounted, this is not Linux, or the mount was ` +
      `set up after boot without updating /etc/mtab. Proceed at your own risk.`,
    )
    return { risks, info }
  }
  if (info.fstype && !NFS_FSTYPES.has(info.fstype)) {
    risks.push(
      `Path "${options.mountPath}" is mounted as ${info.fstype}, not NFS. ` +
      `If you intended a local filesystem, use a local file store instead.`,
    )
  }
  // #70 — the descriptor's logical identity vs. what is actually mounted.
  // Requires both halves of the address AND a device from the detector: a
  // half-stated claim is not checkable, and a detector that cannot report a
  // device (every pre-#70 implementation, including any a consumer injected)
  // must not start manufacturing mismatches.
  if (options.server !== undefined && options.export !== undefined && info.device !== undefined) {
    const claimed = canonicalDevice(`${options.server}:${options.export}`)
    if (canonicalDevice(info.device) !== claimed) {
      risks.push(
        `${DEVICE_MISMATCH_PREFIX} this store claims "${claimed}", but ` +
        `"${options.mountPath}" is mounted from "${info.device}". Writes are ` +
        `landing on the second, not the first. Either the descriptor names the ` +
        `wrong export, or \`binding.mountPath\` points at the wrong mount.`,
      )
    }
  }
  if (info.options?.includes('nolock')) {
    risks.push(
      `NFS mount "${options.mountPath}" has the \`nolock\` option set. ` +
      `POSIX file locks are silently disabled, so concurrent writers may corrupt ` +
      `records without any error surfacing. Remount without \`nolock\` or route ` +
      `writes through a store that implements server-side CAS.`,
    )
  }
  if (info.options && !info.options.includes('noac')) {
    risks.push(
      `NFS mount "${options.mountPath}" uses attribute caching (no \`noac\` flag). ` +
      `Version checks may pass on cached stale data. For multi-writer setups, ` +
      `add \`noac\` to the mount options.`,
    )
  }
  return { risks, info }
}

/**
 * Create an NFS-backed noy-db store. Mount diagnostics run once on
 * first use and are cached — failures raise (or warn) based on
 * `onNolock`.
 */
export function toNfs(options: NfsStoreOptions): NoydbStore & { diagnostics(): Promise<{ risks: string[]; info: MountInfo }> } {
  const onNolock = options.onNolock ?? 'warn'
  const onDeviceMismatch = options.onDeviceMismatch ?? 'warn'
  const base = jsonFile({ dir: options.mountPath })
  let diagnosed: Promise<{ risks: string[]; info: MountInfo }> | null = null

  async function diagnostics(): Promise<{ risks: string[]; info: MountInfo }> {
    if (!diagnosed) {
      diagnosed = (async () => {
        const report = await runMountDiagnostics(options)

        // Each escalation selects its OWN message by predicate. This used to
        // read `risks[0]`, which was correct only while nolock was the sole
        // escalating risk and happened to sit first — adding the #70 device
        // check would have had `onNolock: 'error'` throw the device message.
        const mismatch = report.risks.find(r => r.startsWith(DEVICE_MISMATCH_PREFIX))
        if (mismatch) {
          if (onDeviceMismatch === 'error') throw new Error(`[@noy-db/to-nfs] ${mismatch}`)
          console.warn(`[@noy-db/to-nfs] ${mismatch}`)
        }

        const nolock = report.risks.find(r => r.includes(NOLOCK_MARKER))
        if (nolock) {
          if (onNolock === 'error') throw new Error(`[@noy-db/to-nfs] ${nolock}`)
          console.warn(`[@noy-db/to-nfs] ${nolock}`)
        }
        return report
      })()
    }
    return diagnosed
  }

  // Run diagnostics on first I/O so construction stays synchronous-friendly.
  async function withDiagnostics<T>(fn: () => Promise<T>): Promise<T> {
    await diagnostics()
    return fn()
  }

  return {
    name: 'nfs',
    capabilities: {
      casAtomic: false,
      auth: { kind: 'filesystem', required: false, flow: 'static' },
    },
    async get(vault, collection, id) {
      return withDiagnostics(() => base.get(vault, collection, id))
    },
    async put(vault, collection, id, envelope, expectedVersion) {
      return withDiagnostics(() => base.put(vault, collection, id, envelope, expectedVersion))
    },
    async delete(vault, collection, id) {
      return withDiagnostics(() => base.delete(vault, collection, id))
    },
    async list(vault, collection) {
      return withDiagnostics(() => base.list(vault, collection))
    },
    async loadAll(vault) {
      return withDiagnostics(() => base.loadAll(vault))
    },
    async saveAll(vault, data) {
      return withDiagnostics(() => base.saveAll(vault, data))
    },
    async ping() {
      return base.ping ? base.ping() : true
    },
    diagnostics,
  }
}

// ─── Store-locator descriptor (#58 — `lan` class, binding-slot tier) ────

/**
 * Serializable location of an NFS store. `server` and `export` describe
 * the logical `server:/export` identity.
 *
 * They do not OPEN anything — `binding.mountPath` is what the store opens,
 * because where an export is mounted is device-local and must never travel
 * in a pod. But since #70 they are no longer inert: when both are present
 * they are cross-checked against the device the mount actually came from,
 * which turns the identity from a decorative claim into a checked
 * invariant. See {@link NfsDescriptorOptions.onDeviceMismatch}.
 */
export interface NfsAddress {
  /** Logical NFS server. Cross-checked against the mount device (#70). */
  readonly server?: string
  /** Logical NFS export path. Cross-checked against the mount device (#70). */
  readonly export?: string
}

/** Serializable tuning carried on the descriptor (never credentials). */
export interface NfsDescriptorOptions {
  readonly onNolock?: 'warn' | 'error'
  /**
   * Severity of an `address` ↔ mount-device mismatch: `'warn'` (default)
   * or `'error'`. See {@link NfsStoreOptions.onDeviceMismatch}.
   */
  readonly onDeviceMismatch?: 'warn' | 'error'
}

/**
 * Device-local supplement resolved at `resolve()` time — where the export
 * is actually mounted on this machine, which the descriptor cannot carry.
 * Never serialized into a pod alongside the descriptor.
 */
export interface NfsBinding {
  readonly mountPath: string
  readonly mountDetector?: MountDetector
}

/**
 * Builds the `StoreDescriptor` form of a `toNfs()` store: `kind: 'nfs'`,
 * `class: 'lan'`, with the identity address and the serializable tuning as
 * `options`. Credentialless by construction — the live mount point arrives
 * via `binding.mountPath` at `resolve()` time.
 */
export function nfsStoreDescriptor(address: NfsAddress, options?: NfsDescriptorOptions): StoreDescriptor {
  return { kind: 'nfs', class: 'lan', address, ...(options !== undefined && { options }) }
}

/**
 * `StoreFactory` for `to-nfs`: reconstructs the same store `toNfs()`
 * builds, from a descriptor produced by {@link nfsStoreDescriptor}.
 * `opts.binding.mountPath` is required — `toNfs()` fails fast without a
 * mount point, and where an export is mounted is device-local and never
 * travels in a descriptor.
 */
export const nfsStoreFactory: StoreFactory = (descriptor, opts) => {
  const { onNolock, onDeviceMismatch } = (descriptor.options ?? {}) as NfsDescriptorOptions
  const { server, export: exportPath } = (descriptor.address ?? {}) as NfsAddress
  const binding = (opts.binding ?? {}) as Partial<NfsBinding>
  if (!binding.mountPath) {
    throw new Error(
      '@noy-db/to-nfs: resolving this descriptor requires `binding.mountPath` — ' +
      'where an export is mounted is device-local and never travels in a descriptor. ' +
      'Pass one: locator.resolve(descriptor, { binding: { mountPath } }).',
    )
  }
  return toNfs({
    ...(onNolock !== undefined && { onNolock }),
    ...(onDeviceMismatch !== undefined && { onDeviceMismatch }),
    // The address does not open the store, but it is what the #70
    // cross-check compares the mounted device against.
    ...(server !== undefined && { server }),
    ...(exportPath !== undefined && { export: exportPath }),
    ...(binding.mountDetector !== undefined && { mountDetector: binding.mountDetector }),
    mountPath: binding.mountPath,
  })
}

/** Registers {@link nfsStoreFactory} under the `'nfs'` kind on `locator`. */
export function registerNfsStore(locator: StoreLocator): void {
  locator.register('nfs', nfsStoreFactory)
}
