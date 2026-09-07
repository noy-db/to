/**
 * **@noy-db/to-browser-fs** — File System Access store for NOYDB.
 *
 * The browser sibling to `@noy-db/to-file`. Takes a
 * `FileSystemDirectoryHandle` instead of a path, so a page can read and
 * write a folder the OS has already mounted — a Windows SMB share, a NAS
 * volume, a USB stick. The adapter never speaks a wire protocol: once a
 * volume is mounted, the protocol stops mattering.
 *
 * Layout is byte-identical to `to-file`, so a Node process and a browser
 * can point at the same folder and read each other's writes:
 *
 * ```
 * {root}/
 *   {vault}/
 *     {collection}/
 *       {id}.json          ← EncryptedEnvelope, pretty-printed by default
 *     _keyring/
 *       {userId}.json
 *     _sync/
 *       meta.json
 * ```
 *
 * ## Permissions
 *
 * `requestPermission()` needs transient user activation (~5 s in Chrome),
 * which a vault unlock's PBKDF2 blows straight past. So
 * {@link BrowserFsStore.requestAccess} is the ONLY method in this package
 * that prompts — reads, writes, sync, and `ping` never do. Spend the
 * gesture first, then do the slow work:
 *
 * ```ts
 * if (await store.access() !== 'granted') {
 *   if (!await store.requestAccess()) return   // user declined
 * }
 * await unlockVault(password)                  // activation already spent
 * ```
 *
 * {@link BrowserFsStore.access} reports four states, because "click to
 * reconnect" and "you're off the office network" are different situations
 * for the user and must not be told apart by string-matching an error.
 *
 * Chromium-only by construction — Safari's OPFS is origin-private and
 * cannot see a mounted volume.
 *
 * @packageDocumentation
 */

import type {
  NoydbStore,
  EncryptedEnvelope,
  VaultSnapshot,
  ListPageResult,
  StoreDescriptor,
  StoreFactory,
  StoreLocator,
} from '@noy-db/hub/to'
import { ConflictError } from '@noy-db/hub/to'

/** Minimal structural view of the File System Access handles this store uses. */
export interface DirectoryHandleLike {
  readonly kind: 'directory'
  readonly name: string
  getDirectoryHandle(name: string, options?: { create?: boolean }): Promise<DirectoryHandleLike>
  getFileHandle(name: string, options?: { create?: boolean }): Promise<FileHandleLike>
  removeEntry(name: string, options?: { recursive?: boolean }): Promise<void>
  entries(): AsyncIterable<[string, DirectoryHandleLike | FileHandleLike]>
  queryPermission?(descriptor?: { mode?: string }): Promise<'granted' | 'prompt' | 'denied'>
  requestPermission?(descriptor?: { mode?: string }): Promise<'granted' | 'prompt' | 'denied'>
}

/** Minimal structural view of a File System Access file handle. */
export interface FileHandleLike {
  readonly kind: 'file'
  readonly name: string
  getFile(): Promise<{ text(): Promise<string> }>
  createWritable(options?: { keepExistingData?: boolean }): Promise<WritableLike>
}

/** Minimal structural view of a `FileSystemWritableFileStream`. */
export interface WritableLike {
  write(data: string): Promise<void>
  close(): Promise<void>
}

/**
 * What the store can do with the directory right now.
 *
 * | State | Meaning | What to tell the user |
 * |---|---|---|
 * | `granted` | permission held **and** the volume answers | connected |
 * | `prompt` | no grant yet, or it lapsed on restart | "click to reconnect" |
 * | `denied` | the user refused | "reconnect from settings" |
 * | `unreachable` | grant held, volume does not answer | "off the office network — working locally" |
 */
export type FsAccessState = 'granted' | 'prompt' | 'denied' | 'unreachable'

/** The permission surface this store adds to {@link NoydbStore}. */
export interface FsAccess {
  /**
   * Current access state. Never prompts, and only touches the volume when
   * permission is already granted — probing a dead mount can block for
   * seconds, and there is no reason to pay that when permission has
   * already decided the answer.
   */
  access(): Promise<FsAccessState>
  /**
   * Ask for read-write permission. The ONLY method that prompts, so it
   * must be called from inside a user gesture and before any slow work.
   * Resolves true iff permission is now granted.
   */
  requestAccess(): Promise<boolean>
}

/** A NOYDB store over a directory handle, plus its permission surface. */
export type BrowserFsStore = NoydbStore & FsAccess

/** The permission grant is missing or was revoked — the user must click to reconnect. */
export class FsPermissionError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options)
    this.name = 'FsPermissionError'
  }
}

/** The directory is not answering — unmounted, or off the network entirely. */
export class FsUnreachableError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options)
    this.name = 'FsUnreachableError'
  }
}

/**
 * A write completed but read back different bytes. Chromium's swap file
 * makes a torn target impossible, so this is the other failure mode: a
 * silent short write or a stale cache on the far side of an SMB link.
 */
export class FsWriteVerifyError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'FsWriteVerifyError'
  }
}

/** Options for {@link toBrowserFs}. */
export interface BrowserFsOptions {
  /** Directory handle from `showDirectoryPicker()` or recalled from IndexedDB. */
  readonly handle: DirectoryHandleLike
  /** Pretty-print JSON files. Default: true — matches `to-file`. */
  readonly pretty?: boolean
  /**
   * Read every write back and compare the bytes, throwing
   * {@link FsWriteVerifyError} on a mismatch. Default: true. Costs one
   * extra read per write; turn it off for bulk `saveAll` over a link you
   * trust.
   */
  readonly verifyWrites?: boolean
  /** Diagnostic name. Default: 'browser-fs'. */
  readonly name?: string
  /** Clock uncertainty bound (ms). Default: 0. */
  readonly clockUncertaintyMs?: number
}

function isDirectory(entry: DirectoryHandleLike | FileHandleLike): entry is DirectoryHandleLike {
  return entry.kind === 'directory'
}

function errorName(error: unknown): string {
  return error instanceof Error ? error.name : ''
}

/**
 * Build a NOYDB store over a File System Access directory handle.
 *
 * The handle must already be obtained; this store never prompts on its own.
 */
export function toBrowserFs(options: BrowserFsOptions): BrowserFsStore {
  const { handle: root, pretty = true, verifyWrites = true } = options
  const label = options.name ?? 'browser-fs'

  function serialize(envelope: EncryptedEnvelope): string {
    return pretty ? JSON.stringify(envelope, null, 2) : JSON.stringify(envelope)
  }

  /** One cheap touch of the root handle — does the volume answer at all? */
  async function reachable(): Promise<boolean> {
    try {
      await root.entries()[Symbol.asyncIterator]().next()
      return true
    } catch {
      return false
    }
  }

  /**
   * Turn a raw File System Access failure into one the consumer can branch
   * on. Permission is checked first: a lapsed grant makes every call throw
   * `NotAllowedError`, including the liveness probe, so probing first would
   * misreport it as an unreachable volume.
   */
  async function fail(error: unknown, what: string): Promise<never> {
    if (error instanceof FsWriteVerifyError || error instanceof ConflictError) throw error
    if (errorName(error) === 'NotAllowedError') {
      throw new FsPermissionError(
        `@noy-db/to-browser-fs: permission to ${what} was refused or has lapsed. ` +
        'Call requestAccess() from a user gesture to reconnect.',
        { cause: error },
      )
    }
    if (!(await reachable())) {
      throw new FsUnreachableError(
        `@noy-db/to-browser-fs: the directory is not answering (${what}). ` +
        'The volume is probably unmounted or off the network.',
        { cause: error },
      )
    }
    throw error
  }

  async function dir(path: readonly string[], create: boolean): Promise<DirectoryHandleLike> {
    let current = root
    for (const segment of path) current = await current.getDirectoryHandle(segment, { create })
    return current
  }

  async function readFile(handle: FileHandleLike): Promise<EncryptedEnvelope> {
    const file = await handle.getFile()
    return JSON.parse(await file.text()) as EncryptedEnvelope
  }

  /**
   * Write one record file.
   *
   * `createWritable()` on a real (non-OPFS) handle stages the bytes in a
   * `.crswap` sidecar and swaps it into place on `close()`, so a killed tab
   * can never leave a torn `{id}.json`. The read-back on top of that covers
   * what the swap does not: a write that "succeeded" but landed wrong.
   */
  async function writeRecord(
    collectionDir: DirectoryHandleLike,
    id: string,
    envelope: EncryptedEnvelope,
  ): Promise<void> {
    const filename = `${id}.json`
    const contents = serialize(envelope)
    const file = await collectionDir.getFileHandle(filename, { create: true })
    const writable = await file.createWritable()
    await writable.write(contents)
    await writable.close()

    if (!verifyWrites) return
    const readBack = await (await file.getFile()).text()
    if (readBack !== contents) {
      throw new FsWriteVerifyError(
        `@noy-db/to-browser-fs: ${collectionDir.name}/${filename} read back ` +
        `${readBack.length} bytes after writing ${contents.length}. ` +
        'The write did not land intact — treat it as failed.',
      )
    }
  }

  /** Ids of the `.json` records in a collection — `.crswap` orphans excluded. */
  async function recordIds(collectionDir: DirectoryHandleLike): Promise<string[]> {
    const ids: string[] = []
    for await (const [name, entry] of collectionDir.entries()) {
      if (name.endsWith('.json') && !isDirectory(entry)) ids.push(name.slice(0, -5))
    }
    return ids.sort()
  }

  return {
    name: label,
    capabilities: {
      // A plain directory has no compare-and-set. The hub reads this and
      // refuses `vault.sequence().next()` outright rather than degrading it
      // to a racy read-compare-write — so this tier never mints a document
      // number, and allocation stays on the CAS-capable primary store.
      casAtomic: false,
      serverWriteTime: true,
      auth: { kind: 'filesystem', required: true, flow: 'implicit' },
    },

    async access() {
      const state = (await root.queryPermission?.({ mode: 'readwrite' })) ?? 'granted'
      if (state !== 'granted') return state
      return (await reachable()) ? 'granted' : 'unreachable'
    },

    async requestAccess() {
      const state = (await root.requestPermission?.({ mode: 'readwrite' })) ?? 'granted'
      return state === 'granted'
    },

    async get(vault, collection, id) {
      try {
        const collectionDir = await dir([vault, collection], false)
        return await readFile(await collectionDir.getFileHandle(`${id}.json`))
      } catch (error) {
        if (errorName(error) === 'NotFoundError' && (await reachable())) return null
        return fail(error, `read ${vault}/${collection}/${id}`)
      }
    },

    async put(vault, collection, id, envelope, expectedVersion) {
      try {
        const collectionDir = await dir([vault, collection], true)

        if (expectedVersion !== undefined) {
          // Read-compare-write. A plain directory offers no compare-and-set,
          // so this carries a TOCTOU window — see `capabilities.casAtomic`.
          let existing: EncryptedEnvelope | null = null
          try {
            existing = await readFile(await collectionDir.getFileHandle(`${id}.json`))
          } catch (error) {
            if (errorName(error) !== 'NotFoundError') throw error
          }
          if (existing !== null && existing._v !== expectedVersion) {
            throw new ConflictError(
              existing._v,
              `Version conflict: expected ${expectedVersion}, found ${existing._v}`,
            )
          }
        }

        await writeRecord(collectionDir, id, envelope)
      } catch (error) {
        return fail(error, `write ${vault}/${collection}/${id}`)
      }
    },

    async delete(vault, collection, id) {
      try {
        const collectionDir = await dir([vault, collection], false)
        await collectionDir.removeEntry(`${id}.json`)
      } catch (error) {
        if (errorName(error) === 'NotFoundError' && (await reachable())) return
        return fail(error, `delete ${vault}/${collection}/${id}`)
      }
    },

    async list(vault, collection) {
      try {
        return await recordIds(await dir([vault, collection], false))
      } catch (error) {
        if (errorName(error) === 'NotFoundError' && (await reachable())) return []
        return fail(error, `list ${vault}/${collection}`)
      }
    },

    async loadAll(vault) {
      const snapshot: VaultSnapshot = {}
      let vaultDir: DirectoryHandleLike
      try {
        vaultDir = await dir([vault], false)
      } catch (error) {
        if (errorName(error) === 'NotFoundError' && (await reachable())) return snapshot
        return fail(error, `load ${vault}`)
      }

      try {
        for await (const [collectionName, entry] of vaultDir.entries()) {
          if (collectionName.startsWith('_') || !isDirectory(entry)) continue
          const records: Record<string, EncryptedEnvelope> = {}
          for await (const [fileName, fileEntry] of entry.entries()) {
            if (!fileName.endsWith('.json') || isDirectory(fileEntry)) continue
            records[fileName.slice(0, -5)] = await readFile(fileEntry)
          }
          snapshot[collectionName] = records
        }
      } catch (error) {
        return fail(error, `load ${vault}`)
      }
      return snapshot
    },

    async saveAll(vault, data) {
      try {
        for (const [collectionName, records] of Object.entries(data)) {
          const collectionDir = await dir([vault, collectionName], true)
          for (const [id, envelope] of Object.entries(records)) {
            await writeRecord(collectionDir, id, envelope)
          }
        }
      } catch (error) {
        return fail(error, `save ${vault}`)
      }
    },

    async listPage(vault, collection, cursor, limit = 100): Promise<ListPageResult> {
      let collectionDir: DirectoryHandleLike
      let ids: string[]
      try {
        collectionDir = await dir([vault, collection], false)
        ids = await recordIds(collectionDir)
      } catch (error) {
        if (errorName(error) === 'NotFoundError' && (await reachable())) {
          return { items: [], nextCursor: null }
        }
        return fail(error, `list ${vault}/${collection}`)
      }

      const start = cursor !== undefined ? Number.parseInt(cursor, 10) : 0
      const page = ids.slice(start, start + limit)
      // Envelopes ride along, so a caller never needs a get() per id.
      const items: ListPageResult['items'] = []
      try {
        for (const id of page) {
          items.push({ id, envelope: await readFile(await collectionDir.getFileHandle(`${id}.json`)) })
        }
      } catch (error) {
        return fail(error, `list ${vault}/${collection}`)
      }

      const next = start + page.length
      return { items, nextCursor: next < ids.length ? String(next) : null }
    },

    async listVaults() {
      try {
        const vaults: string[] = []
        for await (const [name, entry] of root.entries()) {
          if (isDirectory(entry)) vaults.push(name)
        }
        return vaults
      } catch (error) {
        return fail(error, 'list vaults')
      }
    },

    async getStoreTime() {
      const now = Date.now()
      const uncertainty = options.clockUncertaintyMs ?? 0
      return { earliest: now - uncertainty, latest: now + uncertainty }
    },

    async ping() {
      return reachable()
    },
  }
}

// ─── Store-locator descriptor (#58 — `lan` class, opaque-client tier) ────

/**
 * Serializable location of a browser-fs store. Identity-only: a directory
 * handle cannot be reconstructed from JSON, so the descriptor names the
 * share for a human and the live handle arrives as a binding.
 */
export interface BrowserFsAddress {
  /** Human label for the share, e.g. 'LAN' or 'Z:\\accounts'. Identity-only. */
  readonly label?: string
  /** Identity-only hint at the mounted path; not consumed by the factory. */
  readonly path?: string
}

/** Serializable tuning carried on the descriptor (never a handle). */
export interface BrowserFsDescriptorOptions {
  readonly pretty?: boolean
  readonly verifyWrites?: boolean
  readonly name?: string
}

/**
 * Device-local supplement resolved at `resolve()` time — the live
 * directory handle, recalled from IndexedDB or freshly picked. Never
 * serialized into a pod alongside the descriptor.
 */
export interface BrowserFsBinding {
  readonly handle: DirectoryHandleLike
}

/**
 * Builds the `StoreDescriptor` form of a `toBrowserFs()` store:
 * `kind: 'browser-fs'`, `class: 'lan'`. Handle-less by construction.
 */
export function browserFsStoreDescriptor(
  address: BrowserFsAddress,
  options?: BrowserFsDescriptorOptions,
): StoreDescriptor {
  return { kind: 'browser-fs', class: 'lan', address, ...(options !== undefined && { options }) }
}

/**
 * `StoreFactory` for `to-browser-fs`. `opts.binding.handle` is required —
 * a `FileSystemDirectoryHandle` cannot be built from an address, only
 * recalled or re-picked.
 */
export const browserFsStoreFactory: StoreFactory = (descriptor, opts) => {
  const options = (descriptor.options ?? {}) as BrowserFsDescriptorOptions
  const binding = (opts.binding ?? {}) as Partial<BrowserFsBinding>
  if (!binding.handle) {
    throw new Error(
      '@noy-db/to-browser-fs: resolving this descriptor requires `binding.handle` — ' +
      'a directory handle cannot be reconstructed from a serialized descriptor. ' +
      'Recall it with recallDirectory(), or re-pick with showDirectoryPicker(), then: ' +
      'locator.resolve(descriptor, { binding: { handle } }).',
    )
  }
  return toBrowserFs({ ...options, handle: binding.handle })
}

/** Registers {@link browserFsStoreFactory} under the `'browser-fs'` kind. */
export function registerBrowserFsStore(locator: StoreLocator): void {
  locator.register('browser-fs', browserFsStoreFactory)
}

export { rememberDirectory, recallDirectory, forgetDirectory } from './handle-store.js'
