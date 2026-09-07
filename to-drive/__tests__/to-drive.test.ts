import { describe, expect, it, beforeEach } from 'vitest'
import { PodVersionConflictError } from '@noy-db/hub'
import { toDrive, memoryHandleStore, newUlid } from '../src/index.js'
import { mockDrive } from './_mock.js'

function bytes(s: string): Uint8Array { return new TextEncoder().encode(s) }

describe('newUlid', () => {
  it('produces a 26-char Crockford Base32 string', () => {
    const id = newUlid()
    expect(id).toHaveLength(26)
    expect(id).toMatch(/^[0-9A-HJ-NP-TV-Z]{26}$/)
  })

  it('sorts lexically as it sorts chronologically across millisecond gaps', async () => {
    const a = newUlid()
    await new Promise(resolve => setTimeout(resolve, 2))
    const b = newUlid()
    // Time prefix guarantees a < b whenever the delay exceeded 1 ms.
    expect(a.slice(0, 10) <= b.slice(0, 10)).toBe(true)
  })
})

describe('@noy-db/to-drive', () => {
  let client: ReturnType<typeof mockDrive>
  beforeEach(() => { client = mockDrive() })

  it('kind is "bundle" and name is "google-drive"', () => {
    const store = toDrive({ drive: client })
    expect(store.kind).toBe('bundle')
    expect(store.name).toBe('google-drive')
  })

  it('readBundle returns null for unknown vault', async () => {
    const store = toDrive({ drive: client })
    expect(await store.readBundle('acme')).toBeNull()
  })

  it('first writeBundle creates a file with a ULID name', async () => {
    const store = toDrive({ drive: client })
    const { version } = await store.writeBundle('acme', bytes('v1'), null)
    expect(version).toBe('1')
    const entries = [...client.files.values()]
    expect(entries).toHaveLength(1)
    // Name is ULID + `.noydb` — no vault name leaked.
    expect(entries[0]!.name).toMatch(/^[0-9A-HJ-NP-TV-Z]{26}\.noydb$/)
  })

  it('subsequent writeBundle updates the same file', async () => {
    const store = toDrive({ drive: client })
    await store.writeBundle('acme', bytes('v1'), null)
    const { version } = await store.writeBundle('acme', bytes('v2'), '1')
    expect(version).toBe('2')
    expect(client.files.size).toBe(1)
  })

  it('writeBundle with wrong expectedVersion throws PodVersionConflictError', async () => {
    const store = toDrive({ drive: client })
    await store.writeBundle('acme', bytes('v1'), null)
    await expect(store.writeBundle('acme', bytes('v2'), '999'))
      .rejects.toBeInstanceOf(PodVersionConflictError)
  })

  it('writeBundle refuses first write when expectedVersion is provided', async () => {
    const store = toDrive({ drive: client })
    await expect(store.writeBundle('acme', bytes('v1'), 'ghost-version'))
      .rejects.toBeInstanceOf(PodVersionConflictError)
  })

  it('readBundle returns current content + version', async () => {
    const store = toDrive({ drive: client })
    const { version } = await store.writeBundle('acme', bytes('hello'), null)
    const read = await store.readBundle('acme')
    expect(read).not.toBeNull()
    expect(new TextDecoder().decode(read!.bytes)).toBe('hello')
    expect(read!.version).toBe(version)
  })

  it('deleteBundle removes the file and clears the handle', async () => {
    const handles = memoryHandleStore()
    const store = toDrive({ drive: client, handles })
    await store.writeBundle('acme', bytes('v1'), null)
    await store.deleteBundle('acme')
    expect(await handles.getHandle('acme')).toBeNull()
    expect(client.files.size).toBe(0)
  })

  it('readBundle clears the handle when the Drive file has vanished', async () => {
    const handles = memoryHandleStore()
    const store = toDrive({ drive: client, handles })
    await store.writeBundle('acme', bytes('v1'), null)
    const handle = (await handles.getHandle('acme'))!
    // Simulate out-of-band delete from the Drive UI.
    client.files.delete(handle.fileId)
    expect(await store.readBundle('acme')).toBeNull()
    expect(await handles.getHandle('acme')).toBeNull()
  })

  it('listBundles reports via the handle registry', async () => {
    const store = toDrive({ drive: client })
    await store.writeBundle('acme', bytes('v1'), null)
    await store.writeBundle('globex', bytes('v1'), null)
    const list = await store.listBundles()
    expect(list.map(b => b.vaultId).sort()).toEqual(['acme', 'globex'])
  })

  it('custom suffix is honored in the created filename', async () => {
    const store = toDrive({ drive: client, suffix: '.nvault' })
    await store.writeBundle('acme', bytes('v1'), null)
    const entry = [...client.files.values()][0]!
    expect(entry.name.endsWith('.nvault')).toBe(true)
  })
})
