import type { SmbHandle } from '../src/index.js'

/** In-memory SMB handle mock — extracted from to-smb.test.ts for the conformance suite (#26). */
export function mockSmb(): SmbHandle & { files: Map<string, string>; dirs: Set<string> } {
  const files = new Map<string, string>()
  const dirs = new Set<string>()
  return {
    files, dirs,
    async readFile(path) {
      const data = files.get(path)
      return data === undefined ? null : new TextEncoder().encode(data)
    },
    async writeFile(path, data) {
      const text = typeof data === 'string'
        ? data
        : new TextDecoder().decode(data instanceof Uint8Array ? data : new Uint8Array(data as ArrayBuffer))
      files.set(path, text)
    },
    async unlink(path) {
      if (!files.has(path)) throw new Error(`unlink: ${path} not found`)
      files.delete(path)
    },
    async mkdir(path) { dirs.add(path) },
    async rename(from, to) {
      const data = files.get(from)
      if (data === undefined) throw new Error(`rename: ${from} not found`)
      files.set(to, data)
      files.delete(from)
    },
    async readdir(path) {
      const prefix = path ? path + '/' : ''
      const out = new Set<string>()
      for (const f of files.keys()) {
        if (!f.startsWith(prefix)) continue
        const rest = f.slice(prefix.length)
        if (!rest) continue
        out.add(rest.split('/')[0]!)
      }
      for (const d of dirs) {
        if (!d.startsWith(prefix) || d === path) continue
        const rest = d.slice(prefix.length)
        if (rest && !rest.includes('/')) out.add(rest)
      }
      if (out.size === 0 && !dirs.has(path) && path !== '') {
        // Return empty, not throw — readdir on non-existent returns no entries
        return []
      }
      return [...out].sort()
    },
    async ping() { return true },
  }
}
