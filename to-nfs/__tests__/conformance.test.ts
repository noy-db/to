/**
 * Shared store-contract conformance (noy-db-to#26).
 *
 * Runs against a REAL filesystem (a fresh tmp dir per case) — to-nfs is a
 * self-contained file store over a pre-mounted path, so the local fs
 * exercises its actual read/write/readdir code; only the mount detector is
 * stubbed (a clean NFSv4 mount), since a tmp dir is not an NFS mount.
 */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runStoreConformanceTests } from '@noy-db/test-adapter-conformance'
import type { MountDetector } from '../src/index.js'
import { toNfs } from '../src/index.js'

const cleanDetector: MountDetector = async () => ({ exists: true, fstype: 'nfs4', options: ['rw', 'noac'] })

const createdDirs: string[] = []

runStoreConformanceTests(
  'to-nfs (real fs, tmp dir per case)',
  async () => {
    const dir = await mkdtemp(join(tmpdir(), 'noydb-nfs-conformance-'))
    createdDirs.push(dir)
    return toNfs({ mountPath: dir, mountDetector: cleanDetector })
  },
  async () => {
    await Promise.all(createdDirs.map(d => rm(d, { recursive: true, force: true })))
  },
)
