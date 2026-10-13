/**
 * Against a REAL MySQL, opt-in: the mock cannot see a collation or a
 * prepared-statement rule, and both bit here (noy-db/family#174).
 *
 * Skipped unless both are set. This repo ships no driver, so the driver is
 * loaded from wherever the runner has one:
 *   NOYDB_MYSQL_URL=mysql://root:pw@127.0.0.1:3306/noydb
 *   NOYDB_MYSQL_DRIVER=/path/to/a/dir/containing/node_modules/mysql2
 */
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import type { EncryptedEnvelope } from '@noy-db/hub'
import type { MysqlClient } from '../src/index.js'
import { toMysql } from '../src/index.js'

const url = process.env.NOYDB_MYSQL_URL
const driverDir = process.env.NOYDB_MYSQL_DRIVER

function env(v: number): EncryptedEnvelope {
  return {
    _noydb: 1, _v: v, _ts: new Date(1700000000000 + v * 1000).toISOString(),
    _iv: 'aaaa', _data: `ciphertext-${v}`, _by: 'alice',
  }
}

describe.skipIf(!url || !driverDir)('@noy-db/to-mysql against a real server', () => {
  const pool = url && driverDir
    ? (createRequire(join(driverDir, 'package.json'))('mysql2/promise') as {
        createPool(o: { uri: string }): MysqlClient & { end(): Promise<void> }
      }).createPool({ uri: url })
    : null
  afterAll(async () => { await pool?.end() })
  let n = 0
  const store = () => toMysql({ client: pool!, tableName: `rs_${Date.now()}_${n++}` })

  it('keeps ids that differ only in case, accent or a NUL distinct', async () => {
    const s = store()
    const ids = ['Abc', 'abc', 'café', 'cafe', 'inv\0x', 'invx']
    for (const [i, id] of ids.entries()) await s.put('v', 'c', id, env(i + 1))
    for (const [i, id] of ids.entries()) expect(await s.get('v', 'c', id)).toEqual(env(i + 1))
    expect((await s.list('v', 'c')).sort()).toEqual([...ids].sort())
  })

  it('pages with listPage (a bound numeric LIMIT is refused by 8.0.22+)', async () => {
    const s = store()
    const ids = ['a', 'b', 'c', 'd', 'e']
    for (const id of ids) await s.put('v', 'c', id, env(1))
    const seen: string[] = []
    let cursor: string | undefined
    do {
      const page = await s.listPage!('v', 'c', cursor, 2)
      seen.push(...page.items.map(x => x.id))
      cursor = page.nextCursor ?? undefined
    } while (cursor !== undefined)
    expect(seen).toEqual(ids)
  })
})
