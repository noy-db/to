import type { SftpHandle } from '../src/index.js'

/**
 * In-memory mock of the SFTP handle. Implements the same rename /
 * readdir / writeFile semantics a real SFTP server would expose,
 * including atomic rename and readdir on missing paths.
 */
export function mockSftp(): SftpHandle & { files: Map<string, string>; dirs: Set<string> } {
  const files = new Map<string, string>()
  const dirs = new Set<string>(['/'])

  const parent = (path: string): string => {
    const i = path.lastIndexOf('/')
    return i <= 0 ? '/' : path.slice(0, i)
  }
  const ensureParents = (path: string): void => {
    let p = parent(path)
    const ancestors: string[] = []
    while (p !== '/' && !dirs.has(p)) {
      ancestors.push(p)
      p = parent(p)
    }
    // No-op when parent missing — mimics the "mkdir -p before write" contract.
  }

  return {
    files, dirs,
    async readFile(path) {
      const data = files.get(path)
      if (data === undefined) return null
      return new TextEncoder().encode(data)
    },
    async writeFile(path, data) {
      const text = typeof data === 'string'
        ? data
        : new TextDecoder().decode(data instanceof Uint8Array ? data : new Uint8Array(data as ArrayBuffer))
      files.set(path, text)
      ensureParents(path)
    },
    async unlink(path) {
      if (!files.has(path)) throw new Error(`unlink: ${path} not found`)
      files.delete(path)
    },
    async mkdir(path, _recursive) {
      dirs.add(path)
      let p = parent(path)
      while (p !== '/' && !dirs.has(p)) {
        dirs.add(p)
        p = parent(p)
      }
    },
    async rename(from, to) {
      const data = files.get(from)
      if (data === undefined) throw new Error(`rename: ${from} not found`)
      files.set(to, data)
      files.delete(from)
    },
    async readdir(path) {
      const prefix = path.endsWith('/') ? path : path + '/'
      const entries = new Set<string>()
      for (const f of files.keys()) {
        if (f.startsWith(prefix)) {
          const rest = f.slice(prefix.length)
          const firstSeg = rest.split('/')[0]!
          entries.add(firstSeg)
        }
      }
      for (const d of dirs) {
        if (d.startsWith(prefix) && d !== path) {
          const rest = d.slice(prefix.length)
          if (rest && !rest.includes('/')) entries.add(rest)
        }
      }
      if (entries.size === 0 && !dirs.has(path)) {
        throw new Error(`readdir: ${path} not found`)
      }
      return [...entries].sort()
    },
    async ping() { return true },
  }
}
