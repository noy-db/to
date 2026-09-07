import type { ICloudFs } from '../src/index.js'

/**
 * In-memory iCloud-Drive fs mock — extracted from to-icloud.test.ts for the
 * conformance suite (#26).
 *
 * `evict()` here simulates the LEGACY `.icloud`-stub shape, which is what
 * exercises the store's stub branch. Modern macOS evicts dataless-in-place
 * instead: the file keeps stat'ing at full size and a plain read blocks,
 * then succeeds. That shape needs no store logic at all, so there is
 * nothing for a mock to stand in for — it is the ordinary read path with
 * latency (#15). Do not read this mock as a model of current macOS.
 */
export function mockFs(): ICloudFs & {
  files: Map<string, { bytes: Uint8Array; mtime: number; size: number }>
  stubs: Set<string>
  offload(path: string): void
} {
  const files = new Map<string, { bytes: Uint8Array; mtime: number; size: number }>()
  const stubs = new Set<string>()
  let now = 1_700_000_000_000

  return {
    files, stubs,
    offload(path) {
      files.delete(path)
      stubs.add(`${path}.icloud`)
    },
    async readFile(path) {
      const entry = files.get(path)
      return entry ? entry.bytes : null
    },
    async writeFile(path, data) {
      now += 1
      const bytes = data instanceof Uint8Array ? data : new Uint8Array(data as ArrayBuffer)
      files.set(path, { bytes, mtime: now, size: bytes.length })
    },
    async unlink(path) { files.delete(path) },
    async readdir(path) {
      const prefix = path.endsWith('/') ? path : path + '/'
      const out = new Set<string>()
      for (const f of files.keys()) {
        if (!f.startsWith(prefix)) continue
        const rest = f.slice(prefix.length)
        if (!rest.includes('/')) out.add(rest)
      }
      for (const s of stubs) {
        if (!s.startsWith(prefix)) continue
        const rest = s.slice(prefix.length)
        if (!rest.includes('/')) out.add(rest)
      }
      return [...out].sort()
    },
    async stat(path) {
      const entry = files.get(path)
      if (entry) return { mtimeMs: entry.mtime, size: entry.size }
      if (stubs.has(path)) return { mtimeMs: 0, size: 0 } // stub metadata
      return null
    },
    async triggerDownload(stubPath) {
      const target = stubPath.replace(/\.icloud$/, '')
      // Rehydrate with dummy content — in the test we replace it manually
      // below via the returned helper. Here we just clear the stub flag.
      stubs.delete(stubPath)
    },
  }
}
