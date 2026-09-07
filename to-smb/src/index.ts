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

function decode(bytes: Uint8Array | Buffer): string {
  if (typeof Buffer !== 'undefined' && bytes instanceof Buffer) return bytes.toString('utf-8')
  return new TextDecoder().decode(bytes)
}

export function toSmb(options: SmbStoreOptions): NoydbStore {
  const { smb: client, remotePath = 'noydb', name = 'smb' } = options
  const root = remotePath.replace(/^\/+|\/+$/g, '')

  const recordPath = (v: string, c: string, id: string): string => join(root, v, c, `${id}.json`)
  const collPath = (v: string, c: string): string => join(root, v, c)
  const vaultPath = (v: string): string => join(root, v)

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

  const store: NoydbStore = {
    name,
    capabilities: {
      casAtomic: false,
      auth: { kind: 'api-key', required: false, flow: 'static' },
    },

    async get(vault, collection, id) {
      const bytes = await client.readFile(recordPath(vault, collection, id))
      if (bytes === null) return null
      return JSON.parse(decode(bytes)) as EncryptedEnvelope
    },

    async put(vault, collection, id, envelope, expectedVersion) {
      // casAtomic: false — the check below is best-effort read-then-write
      // (not atomic under a concurrent writer), but the contract still
      // requires an OBSERVED version mismatch to throw. Reference
      // behaviour: @noy-db/to-file (found by the conformance suite, #26).
      const target = recordPath(vault, collection, id)
      if (expectedVersion !== undefined) {
        const existing = await client.readFile(target)
        if (existing !== null) {
          const current = (JSON.parse(new TextDecoder().decode(existing)) as EncryptedEnvelope)._v
          if (current !== expectedVersion) {
            throw new ConflictError(current, `Version conflict: expected ${expectedVersion}, found ${current}`)
          }
        }
      }
      const tmp = `${target}.tmp`
      await ensureDir(collPath(vault, collection))
      await client.writeFile(tmp, JSON.stringify(envelope))
      await client.rename(tmp, target)
    },

    async delete(vault, collection, id) {
      try {
        await client.unlink(recordPath(vault, collection, id))
      } catch {
        /* idempotent */
      }
    },

    async list(vault, collection) {
      const entries = await safeReaddir(collPath(vault, collection))
      return entries
        .filter(e => e.endsWith('.json') && !e.endsWith('.tmp'))
        .map(e => e.slice(0, -'.json'.length))
        .sort()
    },

    async loadAll(vault) {
      const snap: VaultSnapshot = {}
      const collections = await safeReaddir(vaultPath(vault))
      for (const collection of collections) {
        if (collection.startsWith('_')) continue
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
      const existing = await safeReaddir(vaultPath(vault))
      for (const collection of existing) {
        const ids = await safeReaddir(collPath(vault, collection))
        for (const fname of ids) {
          await client.unlink(join(root, vault, collection, fname)).catch(() => undefined)
        }
      }
      for (const [collection, recs] of Object.entries(data)) {
        await ensureDir(collPath(vault, collection))
        for (const [id, envelope] of Object.entries(recs)) {
          await store.put(vault, collection, id, envelope)
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
