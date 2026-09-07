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
import { join } from 'node:path'
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

export function jsonFile(options: JsonFileOptions): NoydbStore {
  const { dir, pretty = true } = options

  function recordPath(vault: string, collection: string, id: string): string {
    return join(dir, vault, collection, `${id}.json`)
  }

  function collectionDir(vault: string, collection: string): string {
    return join(dir, vault, collection)
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

      if (expectedVersion !== undefined && await fileExists(path)) {
        const existing = JSON.parse(await readFile(path, 'utf-8')) as EncryptedEnvelope
        if (existing._v !== expectedVersion) {
          throw new ConflictError(existing._v, `Version conflict: expected ${expectedVersion}, found ${existing._v}`)
        }
      }

      await ensureDir(collectionDir(vault, collection))
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
      const dirPath = collectionDir(vault, collection)
      try {
        const entries = await readdir(dirPath)
        return entries
          .filter(f => f.endsWith('.json'))
          .map(f => f.slice(0, -5)) // remove .json extension
      } catch {
        return []
      }
    },

    async loadAll(vault) {
      const compDir = join(dir, vault)
      const snapshot: VaultSnapshot = {}

      try {
        const collections = await readdir(compDir)
        for (const collName of collections) {
          if (collName.startsWith('_')) continue // skip _keyring, _sync
          const collPath = join(compDir, collName)
          const collStat = await stat(collPath)
          if (!collStat.isDirectory()) continue

          const records: Record<string, EncryptedEnvelope> = {}
          const files = await readdir(collPath)
          for (const file of files) {
            if (!file.endsWith('.json')) continue
            const id = file.slice(0, -5)
            const content = await readFile(join(collPath, file), 'utf-8')
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
      for (const [collName, records] of Object.entries(data)) {
        const collDir = collectionDir(vault, collName)
        await ensureDir(collDir)
        for (const [id, envelope] of Object.entries(records)) {
          await writeFile(join(collDir, `${id}.json`), serialize(envelope), 'utf-8')
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
