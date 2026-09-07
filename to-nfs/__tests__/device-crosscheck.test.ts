import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createStoreLocator } from '@noy-db/hub/to'
import type { EncryptedEnvelope } from '@noy-db/hub'
import type { MountDetector } from '../src/index.js'
import { toNfs, runMountDiagnostics, registerNfsStore, nfsStoreDescriptor } from '../src/index.js'

// noy-db-to#70 — the descriptor's `server:/export` was documentation that
// nothing verified. `binding.mountPath` says where an export is mounted on
// THIS machine; the address says which export the pod believes it is. A pod
// claiming `nas.local:/exports/vaults`, resolved against a mountPath
// pointing somewhere else, wrote to the wrong place silently and forever.
//
// `detectMount()` already read the device string (`server:/export` for an
// NFS mount) as `parts[0]` and discarded it. The cross-check consumes it.

// Fixed `_ts`: these tests compare a written envelope with a read one by
// value, so the timestamp must not move between the two calls.
const env = (v: number): EncryptedEnvelope =>
  ({ _noydb: 1, _v: v, _ts: '2026-08-07T00:00:00.000Z', _iv: 'i', _data: 'ZA==' })

const mountedAt = (device: string): MountDetector => async () => ({
  exists: true,
  device,
  fstype: 'nfs4',
  options: ['rw', 'noac'],
})

/** A detector that reports no device at all — the pre-#70 MountInfo shape. */
const deviceless: MountDetector = async () => ({
  exists: true,
  fstype: 'nfs4',
  options: ['rw', 'noac'],
})

describe('to-nfs — descriptor address vs. actual mount device (#70)', () => {
  let dir: string

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'noydb-nfs-device-'))
  })

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('a matching device raises no risk', async () => {
    const { risks } = await runMountDiagnostics({
      mountPath: dir,
      mountDetector: mountedAt('nas.local:/exports/vaults'),
      server: 'nas.local',
      export: '/exports/vaults',
    })
    expect(risks.filter(r => /does not match|mounted from/i.test(r))).toEqual([])
  })

  it('a mismatched device raises a risk naming both sides', async () => {
    const { risks } = await runMountDiagnostics({
      mountPath: dir,
      mountDetector: mountedAt('other.local:/exports/other'),
      server: 'nas.local',
      export: '/exports/vaults',
    })
    const risk = risks.find(r => r.includes('nas.local:/exports/vaults'))
    expect(risk).toBeDefined()
    expect(risk).toContain('other.local:/exports/other')
  })

  it('a purely local directory mounted where an NFS export is claimed is caught', async () => {
    const { risks } = await runMountDiagnostics({
      mountPath: dir,
      mountDetector: async () => ({ exists: true, device: '/dev/disk1s1', fstype: 'apfs', options: ['rw'] }),
      server: 'nas.local',
      export: '/exports/vaults',
    })
    expect(risks.some(r => r.includes('/dev/disk1s1'))).toBe(true)
  })

  it('trailing slashes on the export do not produce a false positive', async () => {
    const { risks } = await runMountDiagnostics({
      mountPath: dir,
      mountDetector: mountedAt('nas.local:/exports/vaults/'),
      server: 'nas.local',
      export: '/exports/vaults',
    })
    expect(risks.filter(r => r.includes('nas.local'))).toEqual([])
  })

  // ── Back-compatibility: the check is opt-in on the address being present ──

  it('no cross-check when the address is absent', async () => {
    const { risks } = await runMountDiagnostics({
      mountPath: dir,
      mountDetector: mountedAt('other.local:/exports/other'),
    })
    expect(risks).toEqual([])
  })

  it('no cross-check when only one half of the address is present', async () => {
    const { risks } = await runMountDiagnostics({
      mountPath: dir,
      mountDetector: mountedAt('other.local:/exports/other'),
      server: 'nas.local',
    })
    expect(risks).toEqual([])
  })

  it('no cross-check when the detector reports no device', async () => {
    const { risks } = await runMountDiagnostics({
      mountPath: dir,
      mountDetector: deviceless,
      server: 'nas.local',
      export: '/exports/vaults',
    })
    expect(risks).toEqual([])
  })

  // ── Severity: the onNolock precedent — warn by default, opt in to throw ──

  it('warns by default and still serves reads and writes', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const store = toNfs({
      mountPath: dir,
      mountDetector: mountedAt('other.local:/exports/other'),
      server: 'nas.local',
      export: '/exports/vaults',
    })
    await store.put('v1', 'c1', 'r1', env(1))
    expect(await store.get('v1', 'c1', 'r1')).toEqual(env(1))
    expect(warn).toHaveBeenCalled()
    expect(warn.mock.calls.some(c => String(c[0]).includes('nas.local:/exports/vaults'))).toBe(true)
    warn.mockRestore()
  })

  it("onDeviceMismatch: 'error' throws before any write lands", async () => {
    const store = toNfs({
      mountPath: dir,
      mountDetector: mountedAt('other.local:/exports/other'),
      server: 'nas.local',
      export: '/exports/vaults',
      onDeviceMismatch: 'error',
    })
    await expect(store.put('v1', 'c1', 'r1', env(1))).rejects.toThrow(/nas\.local:\/exports\/vaults/)
  })

  it('a matching device neither warns nor throws', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const store = toNfs({
      mountPath: dir,
      mountDetector: mountedAt('nas.local:/exports/vaults'),
      server: 'nas.local',
      export: '/exports/vaults',
      onDeviceMismatch: 'error',
    })
    await store.put('v1', 'c1', 'r1', env(1))
    expect(await store.get('v1', 'c1', 'r1')).toEqual(env(1))
    expect(warn).not.toHaveBeenCalled()
    warn.mockRestore()
  })

  // ── The nolock branch must keep selecting its OWN message ────────────────

  it('a device mismatch does not hijack the nolock escalation', async () => {
    // Both risks present. `onNolock: 'error'` must throw the NOLOCK message,
    // not whichever risk happens to sit at index 0 of the list.
    const store = toNfs({
      mountPath: dir,
      mountDetector: async () => ({
        exists: true,
        device: 'other.local:/exports/other',
        fstype: 'nfs4',
        options: ['rw', 'nolock', 'noac'],
      }),
      server: 'nas.local',
      export: '/exports/vaults',
      onNolock: 'error',
    })
    await expect(store.put('v1', 'c1', 'r1', env(1))).rejects.toThrow(/nolock/)
  })

  // ── The locator seam carries the address into the check ──────────────────

  it('the factory forwards descriptor address + onDeviceMismatch', async () => {
    const locator = createStoreLocator()
    registerNfsStore(locator)
    const store = await locator.resolve(
      nfsStoreDescriptor({ server: 'nas.local', export: '/exports/vaults' }, { onDeviceMismatch: 'error' }),
      { binding: { mountPath: dir, mountDetector: mountedAt('other.local:/exports/other') } },
    )
    await expect(store.put('v1', 'c1', 'r1', env(1))).rejects.toThrow(/nas\.local:\/exports\/vaults/)
  })

  it('a descriptor without an address still resolves and works', async () => {
    const locator = createStoreLocator()
    registerNfsStore(locator)
    const store = await locator.resolve(nfsStoreDescriptor({}), {
      binding: { mountPath: dir, mountDetector: mountedAt('other.local:/exports/other') },
    })
    await store.put('v1', 'c1', 'r1', env(1))
    expect(await store.get('v1', 'c1', 'r1')).toEqual(env(1))
  })
})
