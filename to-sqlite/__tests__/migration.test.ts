import { describe, expect, it } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import type { EncryptedEnvelope } from '@noy-db/hub'
import { toSqlite, type SqliteDatabase } from '../src/index.js'

/**
 * Real-engine migration test (`node:sqlite`, Node 22+) — the strongest guard
 * for Critical 1/2 of the whole-branch review: `CREATE TABLE IF NOT EXISTS`
 * is a no-op against a table that already exists, so an upgraded deployment
 * needs an explicit `ALTER TABLE ADD COLUMN env` to become writable/readable
 * again. Everything else in this suite runs against a hand-rolled mock that
 * can't catch a real "no such column: env" / strict-null-vs-undefined bug —
 * this test uses the actual SQLite engine against the actual old DDL.
 */
describe('@noy-db/to-sqlite — real-engine migration (node:sqlite)', () => {
  it('opens a legacy pre-`env`-column table, writes new rows, and dual-reads old rows', async () => {
    const raw = new DatabaseSync(':memory:')

    // (a) OLD DDL — the exact schema this store used before the `env`
    // migration (iv/data NOT NULL, no `env` column at all). This matches
    // the genuinely published legacy schema (commit c2fd829): no `del`
    // column either — `del` was only ever added by a later, superseded
    // `_del`-only commit, never by the systemic `env` migration's ALTER
    // (which adds `env` only). A real upgraded/legacy table therefore has
    // no `del` column, which is what makes `listPage`'s explicit SELECT of
    // `del` below break (see (e)).
    raw.exec(`
      CREATE TABLE noydb_envelopes (
        vault TEXT NOT NULL,
        collection TEXT NOT NULL,
        id TEXT NOT NULL,
        v INTEGER NOT NULL,
        ts TEXT NOT NULL,
        iv TEXT NOT NULL,
        data TEXT NOT NULL,
        by TEXT,
        tier INTEGER,
        elevated_by TEXT,
        det TEXT,
        PRIMARY KEY (vault, collection, id)
      )
    `)
    raw
      .prepare(
        `INSERT INTO noydb_envelopes (vault, collection, id, v, ts, iv, data, by, tier, elevated_by, det)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        'v1', 'c1', 'legacy1', 9, '2026-01-01T00:00:00.000Z',
        'legacy-iv', 'legacy-data', 'carol', 3, 'dave', JSON.stringify({ ssn: 'a:b' }),
      )

    // (b) open the NEW store against the SAME (legacy) database. Pre-fix,
    // merely constructing this store did nothing destructive (autoMigrate
    // only ran `CREATE TABLE IF NOT EXISTS`, a no-op here) — the failure
    // surfaced on first use, below.
    const store = toSqlite({ db: raw as unknown as SqliteDatabase })

    // (c) a brand-new put() must succeed — proves the ALTER TABLE ADD
    // COLUMN env landed AND that writing real iv/data values keeps
    // satisfying the legacy table's NOT NULL constraint on those columns.
    // Pre-fix this threw `SqliteError: table noydb_envelopes has no column
    // named env` (INSERT referenced `env`, which didn't exist yet).
    const fresh: EncryptedEnvelope = {
      _noydb: 1,
      _v: 1,
      _ts: '2026-07-09T00:00:00.000Z',
      _iv: 'fresh-iv',
      _data: 'fresh-data',
      _cek: 'wrapped-cek-b64',
    }
    await store.put('v1', 'c1', 'new1', fresh)
    const gotNew = await store.get('v1', 'c1', 'new1')
    expect(gotNew).toEqual(fresh)

    // (d) the pre-seeded legacy row (env absent, real per-column data) still
    // reconstructs correctly via the dual-read fallback. Pre-fix this threw
    // `SyntaxError: "undefined" is not valid JSON` (`row.env !== null` is
    // true when `row.env` is `undefined`, so `JSON.parse(undefined)` ran).
    const gotLegacy = await store.get('v1', 'c1', 'legacy1')
    expect(gotLegacy).toEqual({
      _noydb: 1,
      _v: 9,
      _ts: '2026-01-01T00:00:00.000Z',
      _iv: 'legacy-iv',
      _data: 'legacy-data',
      _by: 'carol',
      _tier: 3,
      _elevatedBy: 'dave',
      _det: { ssn: 'a:b' },
    })

    // (e) `listPage` against the same migrated legacy table must not throw.
    // Pre-fix, its explicit `SELECT … del` referenced a column that only
    // ever existed on tables created after the superseded `_del`-only
    // commit — a genuinely upgraded table (no `del` column, per (a) above)
    // made every `listPage` call fail with `SqliteError: no such column:
    // del`, even though `get`/`loadAll` (which use `SELECT *`) worked fine.
    const page = await store.listPage('v1', 'c1')
    expect(page.items.map(item => item.id)).toEqual(['legacy1', 'new1'])
  })
})
