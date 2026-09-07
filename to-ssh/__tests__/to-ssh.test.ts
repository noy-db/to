import { describe, expect, it, beforeEach } from 'vitest'
import type { EncryptedEnvelope } from '@noy-db/hub'
import { toSsh } from '../src/index.js'
import { mockSftp } from './_mock.js'

function env(v: number): EncryptedEnvelope {
  return {
    _noydb: 1, _v: v, _ts: new Date(1700000000000 + v * 1000).toISOString(),
    _iv: 'aaaa', _data: `ct-${v}`, _by: 'alice',
  }
}

describe('@noy-db/to-ssh', () => {
  let sftp: ReturnType<typeof mockSftp>
  let store: ReturnType<typeof toSsh>
  beforeEach(() => {
    sftp = mockSftp()
    store = toSsh({ sftp, remotePath: 'noydb' })
  })

  it('name defaults to "ssh"', () => {
    expect(store.name).toBe('ssh')
  })

  it('put + get round-trip', async () => {
    await store.put('v1', 'c1', 'r1', env(1))
    expect(await store.get('v1', 'c1', 'r1')).toEqual(env(1))
  })

  it('get returns null for missing records', async () => {
    expect(await store.get('v1', 'c1', 'nope')).toBeNull()
  })

  it('put is atomic — tmp file + rename, never a half-written target', async () => {
    await store.put('v1', 'c1', 'r1', env(1))
    // After a successful put, no lingering .tmp files are visible.
    const allPaths = [...sftp.files.keys()]
    expect(allPaths.some(p => p.endsWith('.tmp'))).toBe(false)
    expect(allPaths.some(p => p.endsWith('/r1.json'))).toBe(true)
  })

  it('list returns sorted record ids', async () => {
    await store.put('v1', 'c1', 'c', env(1))
    await store.put('v1', 'c1', 'a', env(1))
    await store.put('v1', 'c1', 'b', env(1))
    expect(await store.list('v1', 'c1')).toEqual(['a', 'b', 'c'])
  })

  it('list skips tmp files', async () => {
    await store.put('v1', 'c1', 'r1', env(1))
    // Manually inject a leftover tmp — simulates a crashed prior put.
    sftp.files.set('/noydb/v1/c1/orphan.json.tmp', '{}')
    expect(await store.list('v1', 'c1')).toEqual(['r1'])
  })

  it('delete is idempotent', async () => {
    await store.put('v1', 'c1', 'r1', env(1))
    await store.delete('v1', 'c1', 'r1')
    await expect(store.delete('v1', 'c1', 'r1')).resolves.toBeUndefined()
    expect(await store.get('v1', 'c1', 'r1')).toBeNull()
  })

  it('loadAll walks the vault tree and groups by collection', async () => {
    await store.put('v1', 'c1', 'r1', env(1))
    await store.put('v1', 'c2', 'r2', env(2))
    const snap = await store.loadAll('v1')
    expect(Object.keys(snap).sort()).toEqual(['c1', 'c2'])
    expect(snap.c1!.r1).toEqual(env(1))
    expect(snap.c2!.r2).toEqual(env(2))
  })

  it('loadAll omits internal underscore-prefixed collections', async () => {
    await store.put('v1', 'c1', 'r1', env(1))
    // Manually write something under a _system collection.
    sftp.files.set('/noydb/v1/_system/x.json', JSON.stringify(env(9)))
    sftp.dirs.add('/noydb/v1/_system')
    const snap = await store.loadAll('v1')
    expect(snap._system).toBeUndefined()
    expect(snap.c1).toBeDefined()
  })

  it('saveAll replaces vault contents atomically per record', async () => {
    await store.put('v1', 'c1', 'keep', env(1))
    await store.put('v1', 'c1', 'drop', env(2))
    await store.saveAll('v1', { c1: { only: env(5) } })
    const ids = await store.list('v1', 'c1')
    expect(ids).toEqual(['only'])
  })

  it('ping returns true against a live sftp handle', async () => {
    expect(await store.ping!()).toBe(true)
  })

  it('custom name is threaded through for diagnostics', () => {
    const named = toSsh({ sftp: mockSftp(), name: 'my-vps' })
    expect(named.name).toBe('my-vps')
  })
})
