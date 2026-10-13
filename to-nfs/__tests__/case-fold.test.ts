import { describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { jsonFile } from '../src/internal-file-store.js'

const env = (data: string) => ({ _noydb: 1 as const, _v: 1, _ts: '2026-10-14T00:00:00.000Z', _iv: 'aaaa', _data: data })

/** Whether this machine's temp dir folds case: APFS and NTFS do; Linux CI does not, and skips. */
function tmpFoldsCase(): boolean {
  const dir = mkdtempSync(join(tmpdir(), 'nfs-case-'))
  try {
    mkdirSync(join(dir, 'Aa'))
    try { statSync(join(dir, 'aa')); return true } catch { return false }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

describe.skipIf(!tmpFoldsCase())('to-nfs on a case-folding filesystem (family#215)', () => {
  const store = () => jsonFile({ dir: mkdtempSync(join(tmpdir(), 'nfs215-')) })

  it('refuses a folded DIRECTORY component (`_idx/name` against `_idx/Name`)', async () => {
    const s = store()
    await s.put('v', 'c', '_idx/Name/x', env('x'))
    await expect(s.put('v', 'c', '_idx/name/y', env('y'))).rejects.toThrow(/case-folds onto the existing "_idx\/Name"/)
    expect(await s.list('v', 'c')).toEqual(['_idx/Name/x'])
  })

  it("saveAll refuses too, rather than letting its prune delete the snapshot's own record", async () => {
    const s = store()
    await s.put('v', 'c', 'Abc', env('upper'))
    await expect(s.saveAll('v', { c: { abc: env('lower') } })).rejects.toThrow(/case-folds onto the existing "Abc"/)
    expect((await s.get('v', 'c', 'Abc'))?._data).toBe('upper')
  })
})
