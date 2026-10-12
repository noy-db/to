import { describe, expect, it } from 'vitest'
import type { EncryptedEnvelope } from '@noy-db/hub'
import type { PostgresClient } from '../src/index.js'
import { toPostgres } from '../src/index.js'
import { mockClient } from './_mock.js'

// noy-db/family#174 — Postgres `text` refuses a 0x00 byte, so ids are bound
// encoded with to-file's codec (`%` and NUL only) and read back decoded. The
// mock refuses NUL the way the real server does (measured on postgres:16).

function env(v: number): EncryptedEnvelope {
  return {
    _noydb: 1, _v: v, _ts: new Date(1700000000000 + v * 1000).toISOString(),
    _iv: 'aaaa', _data: `ciphertext-${v}`, _by: 'alice',
  }
}

export interface CodecTarget {
  client: PostgresClient
  tableName?: string
  /** Writes a row under a RAW key, the way a pre-family#174 store did. */
  seedRaw(vault: string, collection: string, id: string, envelope: EncryptedEnvelope): Promise<void>
}

export function idCodecSuite(name: string, make: () => CodecTarget): void {
  describe(`${name} id codec (family#174)`, () => {
    it('keeps `a\\0b`, `a%00b` and `a%2500b` three rows, through list, loadAll and a paged listPage', async () => {
      const store = toPostgres(make())
      const ids = ['a\0b', 'a%00b', 'a%2500b', 'b\0z/EU']
      for (const [i, id] of ids.entries()) await store.put('v', 'c', id, env(i + 1))
      for (const [i, id] of ids.entries()) expect(await store.get('v', 'c', id)).toEqual(env(i + 1))
      expect((await store.list('v', 'c')).sort()).toEqual([...ids].sort())
      expect(Object.keys((await store.loadAll('v')).c!).sort()).toEqual([...ids].sort())
      const seen: string[] = []
      let cursor: string | undefined
      do {
        const page = await store.listPage!('v', 'c', cursor, 1)
        seen.push(...page.items.map(x => x.id))
        cursor = page.nextCursor ?? undefined
      } while (cursor !== undefined)
      expect(seen.sort()).toEqual([...ids].sort())
      // The row keyed `a%00b` is where `a\0b` lives: dropping `a%00b` must not take it along.
      await store.delete('v', 'c', 'a%00b')
      expect(await store.get('v', 'c', 'a%00b')).toBeNull()
      expect(await store.get('v', 'c', 'a\0b')).toEqual(env(1))
    })

    it('reads, versions, deletes and lists once a pre-encoding row whose id holds a `%`', async () => {
      const target = make()
      const store = toPostgres(target)
      await store.list('v', 'c') // creates the table
      await target.seedRaw('v', 'c', 'x%3Ay', env(1))
      await target.seedRaw('v', 'c', 'z%3Aw', env(2))

      expect(await store.get('v', 'c', 'x%3Ay')).toEqual(env(1))
      expect(await store.list('v', 'c')).toEqual(['x%3Ay', 'z%3Aw'])
      await store.put('v', 'c', 'z%3Aw', env(3), 2)
      expect(await store.get('v', 'c', 'z%3Aw')).toEqual(env(3))
      expect(await store.list('v', 'c')).toEqual(['x%3Ay', 'z%3Aw'])
      await store.delete('v', 'c', 'x%3Ay')
      expect(await store.get('v', 'c', 'x%3Ay')).toBeNull()
      expect(await store.list('v', 'c')).toEqual(['z%3Aw'])
    })
  })
}

idCodecSuite('@noy-db/to-postgres (mock)', () => {
  const client = mockClient()
  return {
    client,
    async seedRaw(vault, collection, id, envelope) {
      client.rows.set(`${vault}\x00${collection}\x00${id}`, { vault, collection, id, v: envelope._v, envelope })
    },
  }
})
