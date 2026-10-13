import type { SftpHandle } from '../src/index.js'

/**
 * In-memory mock of the SFTP handle. Implements the same rename /
 * readdir / writeFile semantics a real SFTP server would expose,
 * including atomic rename and readdir on missing paths.
 */
export function mockSftp(options: { foldCase?: boolean } = {}): SftpHandle & { files: Map<string, string>; dirs: Set<string> } {
  const files = new Map<string, string>()
  const dirs = new Set<string>(['/'])

  /**
   * `foldCase` (family#215): a share that folds case, as most SMB servers and
   * case-insensitive SFTP targets do. Every segment of a path resolves to an
   * existing entry's spelling when one matches case-insensitively, so writing
   * `abc.json` beside `Abc.json` lands IN `Abc.json` and the listing still
   * says `Abc`, the overwrite family#177 is about.
   */
  const canon = (path: string): string => {
    if (!options.foldCase) return path
    const known = [...dirs, ...files.keys()]
    let out = ''
    for (const [i, seg] of path.split('/').entries()) {
      const cand = i === 0 ? seg : `${out}/${seg}`
      out = seg === '' ? cand : (known.find(k => k.toLowerCase() === cand.toLowerCase()) ?? cand)
    }
    return out
  }

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
    async readFile(rawPath) {
      const path = canon(rawPath)
      const data = files.get(path)
      if (data === undefined) return null
      return new TextEncoder().encode(data)
    },
    async writeFile(rawPath, data) {
      const path = canon(rawPath)
      const text = typeof data === 'string'
        ? data
        : new TextDecoder().decode(data instanceof Uint8Array ? data : new Uint8Array(data as ArrayBuffer))
      files.set(path, text)
      ensureParents(path)
    },
    async unlink(rawPath) {
      const path = canon(rawPath)
      if (!files.has(path)) throw new Error(`unlink: ${path} not found`)
      files.delete(path)
    },
    async mkdir(rawPath, _recursive) {
      const path = canon(rawPath)
      dirs.add(path)
      let p = parent(path)
      while (p !== '/' && !dirs.has(p)) {
        dirs.add(p)
        p = parent(p)
      }
    },
    async rename(rawFrom, rawTo) {
      const from = canon(rawFrom)
      const to = canon(rawTo)
      const data = files.get(from)
      if (data === undefined) throw new Error(`rename: ${from} not found`)
      files.set(to, data)
      files.delete(from)
    },
    async readdir(rawPath) {
      const path = canon(rawPath)
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
