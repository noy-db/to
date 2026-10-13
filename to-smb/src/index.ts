/**
 * **@noy-db/to-smb** — SMB / CIFS network file store for noy-db.
 *
 * Works against Windows file servers, NAS devices (Synology, QNAP,
 * Netgear), and corporate shared drives. Unlike pointing
 * `@noy-db/to-file` at an OS-mounted path, this package speaks SMB
 * directly — no mount step, explicit credential handling, richer
 * reconnection semantics.
 *
 * ## Driver — bring your own
 *
 * Any SMB2/3 client with a promise-style API works. Ready-made: the
 * `smb2` or `@marsaud/smb2` packages on npm. A duck-typed handle is
 * the injection seam — pass a connected client in, noy-db talks to it.
 *
 * ## Auth
 *
 * - **NTLM** — `username` + `password` (+ optional `domain`). Typical
 *   for workgroup NAS.
 * - **Kerberos** — domain-joined environments, ticket from the OS
 *   cache. Setting `authKind: 'kerberos'` tells the driver to leave
 *   password empty and defer to `kinit`.
 *
 * Credentials never hit disk through this adapter — the caller is
 * responsible for sourcing them from a secrets manager. For
 * long-lived integrations, stash them in the vault's encrypted
 * `_sync_credentials` collection and pass them at open time.
 *
 * ## Atomicity
 *
 * SMB has rename but no atomic CAS — same caveat as WebDAV. Per-record
 * writes go through `{id}.json.tmp` + rename, avoiding the partial-write
 * failure mode. For multi-writer CAS, pair with a primary store that
 * implements it.
 *
 * @packageDocumentation
 */

import type {
  NoydbStore,
  EncryptedEnvelope,
  VaultSnapshot,
  StoreDescriptor,
  StoreFactory,
  StoreLocator,
} from '@noy-db/hub/to'
import { ConflictError } from '@noy-db/hub/to'

/**
 * Duck-typed SMB client. Compatible with `smb2` / `@marsaud/smb2`
 * promise wrappers. File paths use Windows-style forward slashes
 * (the SMB client translates to backslashes on the wire).
 */
export interface SmbHandle {
  readFile(path: string): Promise<Uint8Array | Buffer | null>
  writeFile(path: string, data: Uint8Array | Buffer | string): Promise<void>
  unlink(path: string): Promise<void>
  mkdir(path: string): Promise<void>
  rename(from: string, to: string): Promise<void>
  readdir(path: string): Promise<string[]>
  /** Optional liveness check — returns true on a reachable share. */
  ping?(): Promise<boolean>
}

export interface SmbStoreOptions {
  /** Connected SMB client — consumer supplies this. */
  readonly smb: SmbHandle
  /** Relative subdirectory within the share. Default `'noydb'`. */
  readonly remotePath?: string
  /** Diagnostic name. Default `'smb'`. */
  readonly name?: string
}

function join(...parts: string[]): string {
  return parts
    .filter(p => p !== '')
    .map(p => p.replace(/^\/+|\/+$/g, ''))
    .filter(p => p !== '')
    .join('/')
}

/**
 * Segment shape, the rule ruled on family#133 and applied here for family#148.
 * Path joining here strips only edge slashes, so a `..` segment reached the
 * server and resolved outside the vault — and `saveAll` unlinks whatever a
 * listing names.
 *
 * `vault` and `collection` are single names. ⛔ An `id` MAY carry `/`: hub
 * emits `_idx/<field>/<recordId>` ids for persisted index side-cars, so each
 * `/`-separated component is checked instead of refusing the separator.
 */
function isName(value: string): boolean {
  return value !== '' && value !== '.' && value !== '..' && !/[/\\\0]/.test(value)
}

function assertName(value: string, what: string): void {
  if (!isName(value)) {
    throw new Error(`@noy-db/to-smb: ${what} must be a single path segment, got ${JSON.stringify(value)}`)
  }
}

function assertId(id: string): void {
  // A NUL is no longer refused (family#174): hub joins partitioned sequence and
  // period keys with `\x00`, so it is ENCODED instead (see `encodeIdComponent`).
  if (id.includes('\\') || id.split('/').some(p => p === '' || p === '.' || p === '..')) {
    throw new Error(`@noy-db/to-smb: record id must not contain a backslash, or an empty, "." or ".." component, got ${JSON.stringify(id)}`)
  }
}

/**
 * Reversible per-component id encoding (family#174), the same codec as
 * to-file's. `%` is escaped FIRST or `a%00b` and `a\x00b` share one file; the
 * scope is deliberately `%` and NUL only. Applied per `/` component, since `/`
 * maps to a directory.
 */
function encodeIdComponent(part: string): string {
  return part.replace(/%/g, '%25').replace(/\0/g, '%00')
}

/** Exact inverse of {@link encodeIdComponent}, in ONE pass (`%2500` → `%00`). */
function decodeIdComponent(part: string): string {
  return part.replace(/%(25|00)/g, (_m, code: string) => (code === '25' ? '%' : '\0'))
}

const encodeId = (id: string): string => id.split('/').map(encodeIdComponent).join('/')
const decodeId = (id: string): string => id.split('/').map(decodeIdComponent).join('/')

function decode(bytes: Uint8Array | Buffer): string {
  if (typeof Buffer !== 'undefined' && bytes instanceof Buffer) return bytes.toString('utf-8')
  return new TextDecoder().decode(bytes)
}

export function toSmb(options: SmbStoreOptions): NoydbStore {
  const { smb: client, remotePath = 'noydb', name = 'smb' } = options
  const root = remotePath.replace(/^\/+|\/+$/g, '')

  const vaultPath = (v: string): string => {
    assertName(v, 'vault')
    return join(root, v)
  }
  const collPath = (v: string, c: string): string => {
    assertName(c, 'collection')
    return join(vaultPath(v), c)
  }
  const recordPath = (v: string, c: string, id: string): string => {
    assertId(id)
    return join(collPath(v, c), `${encodeId(id)}.json`)
  }
  /**
   * The pre-family#174 path: encoding `%` moved every existing id containing
   * one, so reads and deletes also try the raw name. ⛔ Null whenever the raw
   * name is ANOTHER id's encoded name (`a%00b` is where `a\x00b` lives), or a
   * fallback would read or delete that record. Null too when nothing moved,
   * and for an id holding a NUL, which no pre-encoding record could carry.
   */
  const legacyRecordPath = (v: string, c: string, id: string): string | null =>
    id.includes('\0') || !id.includes('%') || encodeId(decodeId(id)) === id ? null : join(collPath(v, c), `${id}.json`)

  async function ensureDir(path: string): Promise<void> {
    // SMB mkdir is not always recursive — walk parents.
    const parts = path.split('/').filter(Boolean)
    let cur = ''
    for (const seg of parts) {
      cur = cur ? `${cur}/${seg}` : seg
      try {
        await client.mkdir(cur)
      } catch {
        // Exists or race — continue.
      }
    }
  }

  async function safeReaddir(path: string): Promise<string[]> {
    try {
      return await client.readdir(path)
    } catch {
      return []
    }
  }

  /**
   * Record ids under a collection directory, descending into subdirectories:
   * an id may carry `/` (hub's `_idx/<field>/<id>`, family#133), stored as
   * nested directories. `.tmp` files are in-flight writes, never records.
   */
  async function listIds(dir: string, prefix = ''): Promise<string[]> {
    const ids: string[] = []
    for (const e of await safeReaddir(dir)) {
      if (!isName(e) || e.endsWith('.tmp')) continue
      if (e.endsWith('.json')) ids.push(decodeId(prefix + e.slice(0, -'.json'.length)))
      else ids.push(...await listIds(join(dir, e), `${prefix}${e}/`))
    }
    return ids
  }

  /**
   * Whether the share folds case (family#215): most SMB shares do, and so does
   * an SFTP server on APFS or NTFS. Probed once, on the first write, with a
   * sentinel pair: write `…-Aa`, read back `…-aa`. A probe ERROR is not cached
   * as "case-sensitive": over a network a transient failure would switch the
   * guard off for good, so the next write probes again.
   */
  let foldsCase: Promise<boolean> | null = null
  function shareFoldsCase(): Promise<boolean> {
    foldsCase ??= (async () => {
      const probe = join(root, '.noydb-case-probe-Aa')
      await ensureDir(root)
      await client.writeFile(probe, '')
      try {
        return (await client.readFile(join(root, '.noydb-case-probe-aa'))) !== null
      } finally {
        await client.unlink(probe).catch(() => undefined)
      }
    })().catch((err: unknown) => {
      foldsCase = null
      throw err
    })
    return foldsCase
  }

  /**
   * family#177 on a case-folding share: `abc.json` opens the existing
   * `Abc.json`, so the write would replace that record while the file keeps
   * the other id's name. Refused, as to-file and to-nfs refuse it. Every id
   * component is checked, since a folded directory (`_idx/Name` against
   * `_idx/name`) lands in the other id's tree the same way.
   */
  async function assertNoCaseCollision(vault: string, collection: string, id: string): Promise<void> {
    if (!(await shareFoldsCase())) return
    const parts = encodeId(id).split('/')
    parts[parts.length - 1] += '.json'
    let dir = collPath(vault, collection)
    for (const [i, part] of parts.entries()) {
      const entries = await safeReaddir(dir)
      const clash = entries.find(e => e !== part && e.toLowerCase() === part.toLowerCase())
      if (clash !== undefined) {
        const existing = [...parts.slice(0, i), clash].join('/').replace(/\.json$/, '')
        throw new Error(
          `@noy-db/to-smb: record id ${JSON.stringify(id)} case-folds onto the existing ` +
          `${JSON.stringify(decodeId(existing))} on a case-insensitive share, so writing it would ` +
          'replace that record. Use ids that differ by more than case.',
        )
      }
      if (!entries.includes(part)) return // nothing deeper exists to collide with
      dir = join(dir, part)
    }
  }

  const store: NoydbStore = {
    name,
    capabilities: {
      casAtomic: false,
      auth: { kind: 'api-key', required: false, flow: 'static' },
    },

    async get(vault, collection, id) {
      let bytes = await client.readFile(recordPath(vault, collection, id))
      const legacy = bytes === null ? legacyRecordPath(vault, collection, id) : null
      if (legacy !== null) bytes = await client.readFile(legacy)
      if (bytes === null) return null
      return JSON.parse(decode(bytes)) as EncryptedEnvelope
    },

    async put(vault, collection, id, envelope, expectedVersion) {
      // casAtomic: false — the check below is best-effort read-then-write
      // (not atomic under a concurrent writer), but the contract still
      // requires an OBSERVED version mismatch to throw. Reference
      // behaviour: @noy-db/to-file (found by the conformance suite, #26).
      const target = recordPath(vault, collection, id)
      await assertNoCaseCollision(vault, collection, id)
      if (expectedVersion !== undefined) {
        // family#147 — an absent record is at version 0: `0` creates, `N > 0` conflicts.
        // Read through the legacy fallback (family#174), or a pre-encoding record reads as absent.
        const current = (await store.get(vault, collection, id))?._v ?? 0
        if (current !== expectedVersion) {
          throw new ConflictError(current, `Version conflict: expected ${expectedVersion}, found ${current}`)
        }
      }
      // A per-write temp name: two writers sharing `${target}.tmp` clobber each
      // other's temp file and the second rename fails on a path already moved.
      const tmp = `${target}.${Math.random().toString(36).slice(2)}.tmp`
      // The record's own parent, not the collection: an id may carry `/` (family#133).
      await ensureDir(target.slice(0, target.lastIndexOf('/')))
      await client.writeFile(tmp, JSON.stringify(envelope))
      await client.rename(tmp, target)
      // Drop a pre-family#174 copy, so an id never lists twice.
      const legacy = legacyRecordPath(vault, collection, id)
      if (legacy !== null) await client.unlink(legacy).catch(() => undefined)
    },

    async delete(vault, collection, id) {
      // Outside the try: a refused segment must throw, not read as "already gone".
      const target = recordPath(vault, collection, id)
      const legacy = legacyRecordPath(vault, collection, id)
      // A pre-family#174 record under its raw name goes too, or it would resurface.
      if (legacy !== null) await client.unlink(legacy).catch(() => undefined)
      try {
        await client.unlink(target)
      } catch {
        /* idempotent */
      }
    },

    async list(vault, collection) {
      return (await listIds(collPath(vault, collection))).sort()
    },

    async loadAll(vault) {
      const snap: VaultSnapshot = {}
      const collections = await safeReaddir(vaultPath(vault))
      for (const collection of collections) {
        if (!isName(collection) || collection.startsWith('_')) continue
        const ids = await store.list(vault, collection)
        const bucket: Record<string, EncryptedEnvelope> = {}
        for (const id of ids) {
          const env = await store.get(vault, collection, id)
          if (env) bucket[id] = env
        }
        if (Object.keys(bucket).length > 0) snap[collection] = bucket
      }
      return snap
    },

    async saveAll(vault, data) {
      // family#147 — saveAll REPLACES. No transaction here, so WRITE FIRST,
      // PRUNE SECOND: a torn call leaves stale extra records (re-run the
      // restore) instead of a hole. Underscore collections are never pruned.
      for (const [collection, recs] of Object.entries(data)) {
        await ensureDir(collPath(vault, collection))
        for (const [id, envelope] of Object.entries(recs)) {
          await store.put(vault, collection, id, envelope)
        }
      }
      for (const collection of await safeReaddir(vaultPath(vault))) {
        if (!isName(collection) || collection.startsWith('_')) continue
        const keep = data[collection] ?? {}
        for (const id of await store.list(vault, collection)) {
          if (!Object.hasOwn(keep, id)) await store.delete(vault, collection, id)
        }
      }
    },

    async ping() {
      if (client.ping) return client.ping()
      try {
        await client.readdir(root)
        return true
      } catch {
        return false
      }
    },
  }

  return store
}

// ─── Store-locator descriptor (#58 — `lan` class, opaque-client tier) ────

/**
 * Serializable location of an SMB store. `host` and `share` are
 * identity-only — the connection lives in the injected `binding.client`,
 * so the factory does not consume them.
 */
export interface SmbAddress {
  /** Identity-only: not consumed by the factory (the connection carries it). */
  readonly host?: string
  /** Identity-only: not consumed by the factory (the connection carries it). */
  readonly share?: string
  /** Maps to `SmbStoreOptions.remotePath`. Default `'noydb'` when omitted. */
  readonly path?: string
}

/** Serializable tuning carried on the descriptor (never credentials). */
export interface SmbDescriptorOptions {
  readonly name?: string
}

/**
 * Device-local supplement resolved at `resolve()` time — the live
 * `SmbHandle` this store has no way to construct itself. Never serialized
 * into a pod alongside the descriptor.
 */
export interface SmbBinding {
  readonly client: SmbHandle
}

/**
 * Builds the `StoreDescriptor` form of a `toSmb()` store:
 * `kind: 'smb'`, `class: 'lan'`, with the identity address and the
 * serializable tuning as `options`. Credentialless by construction — the
 * live connection arrives via `binding.client` at `resolve()` time.
 */
export function smbStoreDescriptor(address: SmbAddress, options?: SmbDescriptorOptions): StoreDescriptor {
  return { kind: 'smb', class: 'lan', address, ...(options !== undefined && { options }) }
}

/**
 * `StoreFactory` for `to-smb`: reconstructs the same store `toSmb()`
 * builds, from a descriptor produced by {@link smbStoreDescriptor}.
 * `opts.binding.client` is required — this store has no client library of
 * its own and cannot build a connection from `address` alone.
 */
export const smbStoreFactory: StoreFactory = (descriptor, opts) => {
  const address = descriptor.address as SmbAddress
  const { name } = (descriptor.options ?? {}) as SmbDescriptorOptions
  const binding = (opts.binding ?? {}) as Partial<SmbBinding>
  if (!binding.client) {
    throw new Error(
      '@noy-db/to-smb: resolving this descriptor requires `binding.client` — ' +
      'this store does not construct its own connection. ' +
      'Pass one: locator.resolve(descriptor, { binding: { client } }).',
    )
  }
  return toSmb({
    ...(name !== undefined && { name }),
    ...(address.path !== undefined && { remotePath: address.path }),
    smb: binding.client,
  })
}

/** Registers {@link smbStoreFactory} under the `'smb'` kind on `locator`. */
export function registerSmbStore(locator: StoreLocator): void {
  locator.register('smb', smbStoreFactory)
}
