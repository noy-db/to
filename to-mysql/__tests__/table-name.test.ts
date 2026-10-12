import { describe, expect, it } from 'vitest'
import { toMysql } from '../src/index.js'

// noy-db/family#148 — tableName is interpolated into SQL and can arrive from
// a pod-travelling address.table, so only a plain identifier is accepted.
// The refusal happens at construction, before the client is ever touched.
const untouched = new Proxy({}, { get: () => { throw new Error('client touched') } }) as never

describe('@noy-db/to-mysql tableName', () => {
  it.each([
    'noydb_envelopes; DROP TABLE users',
    'my schema',
    'public.noydb',
    '1table',
    '',
  ])('refuses %j', (tableName) => {
    expect(() => toMysql({ client: untouched, tableName })).toThrow(/tableName must match/)
  })

  it('accepts a plain identifier', () => {
    expect(() => toMysql({ client: {} as never, tableName: 'Tenant_42', autoMigrate: false })).not.toThrow()
  })
})
