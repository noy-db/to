import { PodVersionConflictError } from '@noy-db/hub'
import type { DriveClient, DriveFileMeta } from '../src/index.js'

/** In-memory Drive client mock — extracted from to-drive.test.ts for the conformance suite (#26). */
export function mockDrive(): DriveClient & { files: Map<string, { name: string; bytes: Uint8Array; rev: number; parents: string[] }> } {
  const files = new Map<string, { name: string; bytes: Uint8Array; rev: number; parents: string[] }>()
  let nextId = 1

  return {
    files,
    async createFile(req) {
      const id = `file-${nextId++}`
      files.set(id, { name: req.name, bytes: req.bytes, rev: 1, parents: [...req.parents] })
      return { id, name: req.name, headRevisionId: '1', size: req.bytes.length }
    },
    async updateFile(id, req) {
      const entry = files.get(id)
      if (!entry) throw new Error(`update: ${id} not found`)
      if (req.expectedRevision !== undefined && req.expectedRevision !== null && String(entry.rev) !== req.expectedRevision) {
        throw new PodVersionConflictError(`revision mismatch: expected ${req.expectedRevision}, found ${entry.rev}`)
      }
      entry.bytes = req.bytes
      entry.rev += 1
      return { id, name: entry.name, headRevisionId: String(entry.rev), size: req.bytes.length }
    },
    async getFileMetadata(id) {
      const entry = files.get(id)
      if (!entry) return null
      return { id, name: entry.name, headRevisionId: String(entry.rev), size: entry.bytes.length }
    },
    async getFileBytes(id) {
      return files.get(id)?.bytes ?? null
    },
    async deleteFile(id) {
      if (!files.has(id)) throw new Error(`delete: ${id} not found`)
      files.delete(id)
    },
    async listFiles(query) {
      const out: DriveFileMeta[] = []
      for (const [id, entry] of files) {
        if (query.parents && !query.parents.some(p => entry.parents.includes(p))) continue
        if (query.nameExact && entry.name !== query.nameExact) continue
        if (query.namePrefix && !entry.name.startsWith(query.namePrefix)) continue
        out.push({ id, name: entry.name, headRevisionId: String(entry.rev), size: entry.bytes.length })
      }
      return out
    },
  }
}
