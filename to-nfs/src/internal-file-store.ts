/**
 * Internal file-backed NoydbStore implementation for @noy-db/to-nfs.
 *
 * Self-contained file-backed store so that to-nfs does not depend on an external
 * file-store package. NFS-native optimisations (ESTALE handling, attribute-cache
 * invalidation, advisory locking) are intentionally OUT OF SCOPE here —
 * tracked at https://github.com/noy-db/to/issues/1.
 *
 * Maps the NOYDB hierarchy to the filesystem:
 * ```
 * {dir}/{vault}/{collection}/{id}.json
 * {dir}/{vault}/_keyring/{userId}.json
 * ```
 *
 * @internal
 */

import { readFile, writeFile, mkdir, readdir, unlink, stat } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { NoydbStore, EncryptedEnvelope, VaultSnapshot } from '@noy-db/hub/to'
import { ConflictError } from '@noy-db/hub/to'

export interface JsonFileOptions {
  /** Base directory for NOYDB data. */
  dir: string
  /** Pretty-print JSON files. Default: true. */
  pretty?: boolean
  /** Clock uncertainty bound (ms). Default: 0. */
  clockUncertaintyMs?: number
}

/**
 * Segment shape, the rule ruled on family#133 and applied here for family#148:
 * `join` COLLAPSES `..` rather than refusing it, so `join(dir, '..', c, id)`
 * landed outside the mount and read as an ordinary path.
 *
 * `vault` and `collection` are single names. ⛔ An `id` MAY carry `/`: hub
 * emits `_idx/<field>/<recordId>` ids for persisted index side-cars, so each
 * `/`-separated component is checked instead of refusing the separator.
 */
function assertName(value: string, what: string): void {
  if (value === '' || value === '.' || value === '..' || /[/\\\0]/.test(value)) {
    throw new Error(`@noy-db/to-nfs: ${what} must be a single path segment, got ${JSON.stringify(value)}`)
  }
}

function assertId(id: string): void {
  if (/[\\\0]/.test(id) || id.split('/').some(p => p === '' || p === '.' || p === '..')) {
    throw new Error(`@noy-db/to-nfs: record id must not contain a backslash, NUL, or an empty, "." or ".." component, got ${JSON.stringify(id)}`)
  }
}

export function jsonFile(options: JsonFileOptions): NoydbStore {
  const { dir, pretty = true } = options

  function vaultDir(vault: string): string {
    assertName(vault, 'vault')
    return join(dir, vault)
  }

  function collectionDir(vault: string, collection: string): string {
    assertName(collection, 'collection')
    return join(vaultDir(vault), collection)
  }

  function recordPath(vault: string, collection: string, id: string): string {
    assertId(id)
    return join(collectionDir(vault, collection), `${id}.json`)
  }

  async function ensureDir(path: string): Promise<void> {
    await mkdir(path, { recursive: true })
  }

  async function fileExists(path: string): Promise<boolean> {
    try {
      await stat(path)
      return true
    } catch {
      return false
    }
  }

  /**
   * Record ids under a collection directory, descending into subdirectories:
   * an id may carry `/` (hub's `_idx/<field>/<id>`, family#133), stored as
   * nested directories. A missing directory has no ids.
   */
  async function listIds(path: string, prefix = ''): Promise<string[]> {
    let entries
    try {
      entries = await readdir(path, { withFileTypes: true })
    } catch {
      return []
    }
    const ids: string[] = []
    for (const e of entries) {
      if (e.isDirectory()) ids.push(...await listIds(join(path, e.name), `${prefix}${e.name}/`))
      else if (e.name.endsWith('.json')) ids.push(prefix + e.name.slice(0, -'.json'.length))
    }
    return ids
  }

  function serialize(envelope: EncryptedEnvelope): string {
    return pretty ? JSON.stringify(envelope, null, 2) : JSON.stringify(envelope)
  }

  return {
    name: 'file',
    capabilities: {
      casAtomic: false,
      serverWriteTime: true,
      auth: { kind: 'filesystem', required: false, flow: 'static' },
    },

    async getStoreTime() {
      const now = Date.now()
      const ε = options.clockUncertaintyMs ?? 0
      return { earliest: now - ε, latest: now + ε }
    },

    async get(vault, collection, id) {
      const path = recordPath(vault, collection, id)
      try {
        const content = await readFile(path, 'utf-8')
        return JSON.parse(content) as EncryptedEnvelope
      } catch {
        return null
      }
    },

    async put(vault, collection, id, envelope, expectedVersion) {
      const path = recordPath(vault, collection, id)

      if (expectedVersion !== undefined) {
        // family#147 — an absent record is at version 0: `0` creates, `N > 0` conflicts.
        const current = await fileExists(path)
          ? (JSON.parse(await readFile(path, 'utf-8')) as EncryptedEnvelope)._v
          : 0
        if (current !== expectedVersion) {
          throw new ConflictError(current, `Version conflict: expected ${expectedVersion}, found ${current}`)
        }
      }

      // The record's own parent, not the collection: an id may carry `/` (family#133).
      await ensureDir(dirname(path))
      await writeFile(path, serialize(envelope), 'utf-8')
    },

    async delete(vault, collection, id) {
      const path = recordPath(vault, collection, id)
      try {
        await unlink(path)
      } catch {
        // File doesn't exist — that's fine
      }
    },

    async list(vault, collection) {
      return listIds(collectionDir(vault, collection))
    },

    async loadAll(vault) {
      const compDir = vaultDir(vault)
      const snapshot: VaultSnapshot = {}

      try {
        const collections = await readdir(compDir)
        for (const collName of collections) {
          if (collName.startsWith('_')) continue // skip _keyring, _sync
          const collPath = join(compDir, collName)
          const collStat = await stat(collPath)
          if (!collStat.isDirectory()) continue

          const records: Record<string, EncryptedEnvelope> = {}
          for (const id of await listIds(collPath)) {
            const content = await readFile(join(collPath, `${id}.json`), 'utf-8')
            records[id] = JSON.parse(content) as EncryptedEnvelope
          }
          snapshot[collName] = records
        }
      } catch {
        // Directory doesn't exist — return empty snapshot
      }

      return snapshot
    },

    async saveAll(vault, data) {
      // family#147 — saveAll REPLACES. No transaction on a filesystem, so WRITE
      // FIRST, PRUNE SECOND: a torn call leaves stale extra records (re-run the
      // restore) instead of a hole. Underscore collections are never pruned.
      for (const [collName, records] of Object.entries(data)) {
        await ensureDir(collectionDir(vault, collName))
        for (const [id, envelope] of Object.entries(records)) {
          const path = recordPath(vault, collName, id)
          await ensureDir(dirname(path))
          await writeFile(path, serialize(envelope), 'utf-8')
        }
      }
      let collections: string[]
      try {
        collections = await readdir(vaultDir(vault))
      } catch {
        return // no vault directory: an empty snapshot into a vault that never existed
      }
      for (const collName of collections) {
        if (collName.startsWith('_')) continue
        const keep = data[collName] ?? {}
        for (const id of await listIds(collectionDir(vault, collName))) {
          if (!Object.hasOwn(keep, id)) await unlink(recordPath(vault, collName, id))
        }
      }
    },

    async ping() {
      try {
        await stat(dir)
        return true
      } catch {
        return false
      }
    },

    async listVaults() {
      let entries: string[]
      try {
        entries = await readdir(dir)
      } catch {
        return []
      }
      const compartments: string[] = []
      for (const entry of entries) {
        try {
          const entryStat = await stat(join(dir, entry))
          if (entryStat.isDirectory()) compartments.push(entry)
        } catch {
          // Entry vanished between readdir and stat — skip silently.
        }
      }
      return compartments
    },

    async listPage(vault, collection, cursor, limit = 100) {
      const dirPath = collectionDir(vault, collection)
      let files: string[]
      try {
        files = await readdir(dirPath)
      } catch {
        return { items: [], nextCursor: null }
      }

      const ids = files
        .filter(f => f.endsWith('.json'))
        .map(f => f.slice(0, -5))
        .sort()

      const start = cursor ? parseInt(cursor, 10) : 0
      const end = Math.min(start + limit, ids.length)

      const items: Array<{ id: string; envelope: EncryptedEnvelope }> = []
      for (let i = start; i < end; i++) {
        const id = ids[i]!
        try {
          const content = await readFile(join(dirPath, `${id}.json`), 'utf-8')
          items.push({ id, envelope: JSON.parse(content) as EncryptedEnvelope })
        } catch {
          // File disappeared between readdir and readFile — skip silently.
        }
      }

      return {
        items,
        nextCursor: end < ids.length ? String(end) : null,
      }
    },
  }
}
