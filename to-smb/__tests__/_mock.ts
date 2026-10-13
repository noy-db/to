import type { SmbHandle } from '../src/index.js'

/** In-memory SMB handle mock — extracted from to-smb.test.ts for the conformance suite (#26). */
export function mockSmb(options: { foldCase?: boolean } = {}): SmbHandle & { files: Map<string, string>; dirs: Set<string> } {
  const files = new Map<string, string>()
  const dirs = new Set<string>()

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
  return {
    files, dirs,
    async readFile(rawPath) {
      const path = canon(rawPath)
      const data = files.get(path)
      return data === undefined ? null : new TextEncoder().encode(data)
    },
    async writeFile(rawPath, data) {
      const path = canon(rawPath)
      const text = typeof data === 'string'
        ? data
        : new TextDecoder().decode(data instanceof Uint8Array ? data : new Uint8Array(data as ArrayBuffer))
      files.set(path, text)
    },
    async unlink(rawPath) {
      const path = canon(rawPath)
      if (!files.has(path)) throw new Error(`unlink: ${path} not found`)
      files.delete(path)
    },
    async mkdir(path) { dirs.add(canon(path)) },
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
