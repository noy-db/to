import { describe, it, expect } from 'vitest'
import { writeFileSync, mkdtempSync, readdirSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'

/**
 * Every `to-*` package directory in the repo, derived from the filesystem
 * rather than transcribed as a count.
 *
 * #93: `to-browser-fs` was missing from WIRING, so the docs-bridge job threw
 * on both 0.6.0-pre.2 and 0.6.0-pre.3 — no payload asset, no doc-sync issue —
 * while each run still reported success, because that job is deliberately
 * non-fatal. A hard-coded `toHaveLength(n)` does not catch a missing entry;
 * it only catches someone forgetting to bump the number. Deriving the
 * expected set moves the failure into the PR that adds the store.
 */
function shippedStoreDirs(): string[] {
  const root = fileURLToPath(new URL('../../', import.meta.url))
  return readdirSync(root)
    .filter((d) => d.startsWith('to-') && existsSync(join(root, d, 'package.json')))
    .sort()
}

// Minimal localStorage shim — to-browser-local captures the global.
if (!('localStorage' in globalThis)) {
  const m = new Map<string, string>()
  ;(globalThis as Record<string, unknown>).localStorage = {
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => void m.set(k, String(v)),
    removeItem: (k: string) => void m.delete(k),
    clear: () => m.clear(),
    key: (i: number) => [...m.keys()][i] ?? null,
    get length() { return m.size },
  }
}

import { toAwsDynamo } from '../../to-aws-dynamo/src/index.js'
import { fakeDynamo } from '../../to-aws-dynamo/__tests__/_fake-dynamo.js'
import { toAwsS3 } from '../../to-aws-s3/src/index.js'
import { fakeS3 } from '../../to-aws-s3/__tests__/_fake-s3.js'
import { toBrowserFs } from '../../to-browser-fs/src/index.js'
import { fakeRoot } from '../../to-browser-fs/__tests__/fake-fs.js'
import { toBrowserLocal } from '../../to-browser-local/src/index.js'
import { toCloudflareD1 } from '../../to-cloudflare-d1/src/index.js'
import { d1OverNodeSqlite } from '../../to-cloudflare-d1/__tests__/_engine.js'
import { toCloudflareR2 } from '../../to-cloudflare-r2/src/index.js'
import { toDrive } from '../../to-drive/src/index.js'
import { mockDrive } from '../../to-drive/__tests__/_mock.js'
import { toIcloud } from '../../to-icloud/src/index.js'
import { mockFs } from '../../to-icloud/__tests__/_mock.js'
import { toMemory } from '../../to-memory/src/index.js'
import { toMysql } from '../../to-mysql/src/index.js'
import { mockClient as mysqlMock } from '../../to-mysql/__tests__/_mock.js'
import { toNfs, type MountDetector } from '../../to-nfs/src/index.js'
import { toPostgres } from '../../to-postgres/src/index.js'
import { mockClient as pgMock } from '../../to-postgres/__tests__/_mock.js'
import { toSmb } from '../../to-smb/src/index.js'
import { mockSmb } from '../../to-smb/__tests__/_mock.js'
import { toSqlite } from '../../to-sqlite/src/index.js'
import { toSsh } from '../../to-ssh/src/index.js'
import { mockSftp } from '../../to-ssh/__tests__/_mock.js'
import { toRest } from '../../to-rest/src/index.js'
import { restHarness } from '../../to-rest/__tests__/_harness.js'
import { toSupabase } from '../../to-supabase/src/index.js'
import { toTurso } from '../../to-turso/src/index.js'
import { libsqlOverNodeSqlite } from '../../to-turso/__tests__/_engine.js'
import { toWebdav } from '../../to-webdav/src/index.js'
import { fakeDav } from '../../to-webdav/__tests__/_fake-dav.js'

const cleanDetector: MountDetector = async () => ({ exists: true, fstype: 'nfs4', options: ['rw', 'noac'] })

// The wiring table — one entry per published store. `conditionalBits` names
// the individual capability bits that vary with construction options
// (noy-db/core#930; recorded value = the conformance/representative
// configuration). The dump derives the store-level `optionDependent` flag
// from it for backward compatibility.
const WIRING: Record<string, { factory: string; shape: 'record' | 'vault'; conditionalBits?: readonly string[]; make: () => unknown }> = {
  'to-aws-dynamo':    { factory: 'toAwsDynamo',    shape: 'record', make: () => toAwsDynamo({ table: 't', client: fakeDynamo().client }) },
  'to-aws-s3':        { factory: 'toAwsS3',        shape: 'record', make: () => toAwsS3({ bucket: 'b', client: fakeS3().client }) },
  'to-browser-fs':    { factory: 'toBrowserFs',    shape: 'record', make: () => toBrowserFs({ handle: fakeRoot() }) },
  'to-browser-local': { factory: 'toBrowserLocal', shape: 'record', make: () => toBrowserLocal({ prefix: 'docs-bridge-dump' }) },
  'to-cloudflare-d1': { factory: 'toCloudflareD1', shape: 'record', make: () => toCloudflareD1({ db: d1OverNodeSqlite() }) },
  'to-cloudflare-r2': { factory: 'toCloudflareR2', shape: 'record', make: () => toCloudflareR2({ bucket: 'b', client: fakeS3().client }) },
  'to-drive':         { factory: 'toDrive',        shape: 'vault',  make: () => toDrive({ drive: mockDrive() }) },
  'to-icloud':        { factory: 'toIcloud',       shape: 'vault',  make: () => toIcloud({ folder: '/docs-bridge-dump', fs: mockFs() }) },
  'to-memory':        { factory: 'toMemory',       shape: 'record', make: () => toMemory() },
  'to-mysql':         { factory: 'toMysql',        shape: 'record', make: () => toMysql({ client: mysqlMock() }) },
  'to-nfs':           { factory: 'toNfs',          shape: 'record', make: () => toNfs({ mountPath: mkdtempSync(join(tmpdir(), 'docs-bridge-nfs-')), mountDetector: cleanDetector }) },
  'to-postgres':      { factory: 'toPostgres',     shape: 'record', make: () => toPostgres({ client: pgMock() }) },
  'to-rest':          { factory: 'toRest',         shape: 'record', make: () => toRest({ baseUrl: 'https://dump.example.com', headers: { authorization: 'Bearer test-key' }, fetch: restHarness().fetch }) },
  'to-smb':           { factory: 'toSmb',          shape: 'record', make: () => toSmb({ smb: mockSmb() }) },
  'to-sqlite':        { factory: 'toSqlite',       shape: 'record', make: () => toSqlite({ db: new DatabaseSync(':memory:') }) },
  'to-ssh':           { factory: 'toSsh',          shape: 'record', make: () => toSsh({ sftp: mockSftp(), remotePath: 'noydb' }) },
  'to-supabase':      { factory: 'toSupabase',     shape: 'record', make: () => toSupabase({ client: pgMock() }) },
  // txAtomic is client-conditional: `staticClient ? typeof staticClient.batch === 'function' : true`
  'to-turso':         { factory: 'toTurso',        shape: 'record', conditionalBits: ['txAtomic'], make: () => toTurso({ client: libsqlOverNodeSqlite() }) },
  'to-webdav':        { factory: 'toWebdav',       shape: 'record', make: () => toWebdav({ baseUrl: 'https://dump.example.com', fetch: fakeDav().fetch }) },
}

describe('docs-bridge capability dump', () => {
  it('WIRING covers every shipped to-* package', () => {
    expect(Object.keys(WIRING).sort()).toEqual(shippedStoreDirs())
  })

  it('constructs every shipped store and dumps factory/shape/capabilities (writes DOCS_BRIDGE_CAPS_OUT when set)', () => {
    const dump: Record<string, { factory: string; shape: string; capabilities: object | null; optionDependent: boolean; conditionalBits?: readonly string[] }> = {}
    for (const [dir, w] of Object.entries(WIRING)) {
      const store = w.make() as { capabilities?: object }
      const capabilities = w.shape === 'record' ? store.capabilities ?? null : null
      if (w.shape === 'record') {
        expect(capabilities, `${dir}: record store must expose capabilities`).toBeTruthy()
      }
      expect(w.factory).toMatch(/^to[A-Z]/)
      dump[dir] = {
        factory: w.factory, shape: w.shape, capabilities,
        optionDependent: (w.conditionalBits?.length ?? 0) > 0,
        ...(w.conditionalBits?.length ? { conditionalBits: w.conditionalBits } : {}),
      }
    }
    expect(Object.keys(dump).sort()).toEqual(shippedStoreDirs())

    // Per-bit option-dependence (noy-db/core#930): to-turso's txAtomic is
    // the only client-conditional bit today; every other entry omits the field.
    expect(dump['to-turso']).toMatchObject({ optionDependent: true, conditionalBits: ['txAtomic'] })
    for (const [dir, entry] of Object.entries(dump)) {
      if (dir === 'to-turso') continue
      expect(entry.optionDependent, dir).toBe(false)
      expect('conditionalBits' in entry, dir).toBe(false)
    }

    const out = process.env['DOCS_BRIDGE_CAPS_OUT']
    if (out) writeFileSync(out, JSON.stringify(dump, null, 2) + '\n')
  })
})
