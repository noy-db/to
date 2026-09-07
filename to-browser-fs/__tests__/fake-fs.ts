/**
 * In-memory stand-in for the File System Access API subset `to-browser-fs`
 * uses. CI has no Chrome and no mounted share, so the store is exercised
 * against this instead.
 *
 * Beyond mimicking the real API it adds three affordances a real filesystem
 * cannot give a test on demand:
 *
 *   - `volume.permission` — flip between 'granted' / 'prompt' / 'denied',
 *     and count how many times `requestPermission()` was called,
 *   - `volume.mounted = false` — the share stops answering, as when a laptop
 *     leaves the office network,
 *   - `volume.corruptWrite` — a hook that rewrites bytes on their way to
 *     disk, standing in for a silent SMB short write.
 */

export type PermissionState = 'granted' | 'prompt' | 'denied'

interface DirNode {
  kind: 'directory'
  children: Map<string, DirNode | FileNode>
}

interface FileNode {
  kind: 'file'
  contents: string
}

export interface FakeVolume {
  /** Current permission on every handle rooted at this volume. */
  permission: PermissionState
  /** What `requestPermission()` will resolve to. Defaults to 'granted'. */
  promptResult: PermissionState
  /** How many times `requestPermission()` has been called. */
  requests: number
  /** false — the volume stopped answering (unmounted / off the network). */
  mounted: boolean
  /** Rewrite bytes on their way to disk; return undefined to write them as-is. */
  corruptWrite?: (path: string, data: string) => string | undefined
}

function notAllowed(): DOMException {
  return new DOMException('The request is not allowed by the user agent.', 'NotAllowedError')
}

function notFound(name: string): DOMException {
  return new DOMException(`A requested file or directory could not be found: ${name}`, 'NotFoundError')
}

class FakeWritable {
  #buffer = ''

  constructor(
    private readonly volume: FakeVolume,
    private readonly node: FileNode,
    private readonly path: string,
  ) {}

  async write(data: string): Promise<void> {
    if (!this.volume.mounted) throw notFound(this.path)
    this.#buffer += data
  }

  /**
   * Mirrors the platform guarantee that matters here: nothing reaches the
   * target file until `close()`, so a killed tab can never leave a torn
   * `{id}.json` behind.
   */
  async close(): Promise<void> {
    if (!this.volume.mounted) throw notFound(this.path)
    if (this.volume.permission !== 'granted') throw notAllowed()
    const corrupted = this.volume.corruptWrite?.(this.path, this.#buffer)
    this.node.contents = corrupted ?? this.#buffer
  }
}

export class FakeFileHandle {
  readonly kind = 'file'

  constructor(
    readonly name: string,
    private readonly volume: FakeVolume,
    private readonly node: FileNode,
    private readonly path: string,
  ) {}

  #assert(): void {
    if (!this.volume.mounted) throw notFound(this.path)
    if (this.volume.permission !== 'granted') throw notAllowed()
  }

  async getFile(): Promise<{ text(): Promise<string> }> {
    this.#assert()
    const contents = this.node.contents
    return { text: async () => contents }
  }

  async createWritable(): Promise<FakeWritable> {
    this.#assert()
    return new FakeWritable(this.volume, this.node, this.path)
  }
}

export class FakeDirectoryHandle {
  readonly kind = 'directory'

  constructor(
    readonly name: string,
    readonly volume: FakeVolume,
    private readonly node: DirNode,
    private readonly path = '',
  ) {}

  #assert(): void {
    if (!this.volume.mounted) throw notFound(this.path || '/')
    if (this.volume.permission !== 'granted') throw notAllowed()
  }

  #child(name: string): string {
    return this.path === '' ? name : `${this.path}/${name}`
  }

  async queryPermission(_descriptor?: { mode?: string }): Promise<PermissionState> {
    return this.volume.permission
  }

  async requestPermission(_descriptor?: { mode?: string }): Promise<PermissionState> {
    this.volume.requests++
    this.volume.permission = this.volume.promptResult
    return this.volume.permission
  }

  async getDirectoryHandle(name: string, options?: { create?: boolean }): Promise<FakeDirectoryHandle> {
    this.#assert()
    let entry = this.node.children.get(name)
    if (entry === undefined) {
      if (!options?.create) throw notFound(this.#child(name))
      entry = { kind: 'directory', children: new Map() } satisfies DirNode
      this.node.children.set(name, entry)
    }
    if (entry.kind !== 'directory') throw new DOMException(`${name} is a file`, 'TypeMismatchError')
    return new FakeDirectoryHandle(name, this.volume, entry, this.#child(name))
  }

  async getFileHandle(name: string, options?: { create?: boolean }): Promise<FakeFileHandle> {
    this.#assert()
    let entry = this.node.children.get(name)
    if (entry === undefined) {
      if (!options?.create) throw notFound(this.#child(name))
      entry = { kind: 'file', contents: '' } satisfies FileNode
      this.node.children.set(name, entry)
    }
    if (entry.kind !== 'file') throw new DOMException(`${name} is a directory`, 'TypeMismatchError')
    return new FakeFileHandle(name, this.volume, entry, this.#child(name))
  }

  async removeEntry(name: string, _options?: { recursive?: boolean }): Promise<void> {
    this.#assert()
    if (!this.node.children.delete(name)) throw notFound(this.#child(name))
  }

  async *entries(): AsyncGenerator<[string, FakeDirectoryHandle | FakeFileHandle]> {
    this.#assert()
    for (const [name, entry] of [...this.node.children]) {
      yield entry.kind === 'directory'
        ? [name, new FakeDirectoryHandle(name, this.volume, entry, this.#child(name))]
        : [name, new FakeFileHandle(name, this.volume, entry, this.#child(name))]
    }
  }

  async *values(): AsyncGenerator<FakeDirectoryHandle | FakeFileHandle> {
    for await (const [, entry] of this.entries()) yield entry
  }

  /** Test-only: plant a file the store did not write (e.g. a `.crswap` orphan). */
  plant(path: string, contents: string): void {
    const parts = path.split('/')
    const filename = parts.pop()!
    let node = this.node
    for (const part of parts) {
      let next = node.children.get(part)
      if (next === undefined) {
        next = { kind: 'directory', children: new Map() } satisfies DirNode
        node.children.set(part, next)
      }
      if (next.kind !== 'directory') throw new Error(`plant: ${part} is a file`)
      node = next
    }
    node.children.set(filename, { kind: 'file', contents })
  }

  /** Test-only: read a file the store wrote, by path relative to this root. */
  peek(path: string): string | null {
    const parts = path.split('/')
    const filename = parts.pop()!
    let node = this.node
    for (const part of parts) {
      const next = node.children.get(part)
      if (next === undefined || next.kind !== 'directory') return null
      node = next
    }
    const file = node.children.get(filename)
    return file !== undefined && file.kind === 'file' ? file.contents : null
  }

  /** Test-only: every file path in the tree, sorted. */
  paths(): string[] {
    const out: string[] = []
    const walk = (node: DirNode, prefix: string): void => {
      for (const [name, entry] of node.children) {
        const p = prefix === '' ? name : `${prefix}/${name}`
        if (entry.kind === 'directory') walk(entry, p)
        else out.push(p)
      }
    }
    walk(this.node, '')
    return out.sort()
  }
}

/** A fresh, mounted, granted volume with an empty root directory. */
export function fakeRoot(overrides: Partial<FakeVolume> = {}, name = 'root'): FakeDirectoryHandle {
  const volume: FakeVolume = {
    permission: 'granted',
    promptResult: 'granted',
    requests: 0,
    mounted: true,
    ...overrides,
  }
  return new FakeDirectoryHandle(name, volume, { kind: 'directory', children: new Map() })
}
