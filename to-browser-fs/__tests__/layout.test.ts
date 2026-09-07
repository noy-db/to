import { describe, expect, test } from 'vitest'
import { fakeRoot } from './fake-fs.js'
import { toBrowserFs } from '../src/index.js'

const envelope = { _v: 1, _ts: '2026-08-11T00:00:00.000Z', _data: 'Y2lwaGVydGV4dA==' }

describe('on-disk layout', () => {
  test('writes {vault}/{collection}/{id}.json, matching to-file', async () => {
    const root = fakeRoot()
    const store = toBrowserFs({ handle: root })

    await store.put('acme', 'invoices', 'inv-1', envelope)

    expect(root.paths()).toEqual(['acme/invoices/inv-1.json'])
  })

  test('pretty-prints with two spaces by default, as to-file does', async () => {
    const root = fakeRoot()
    const store = toBrowserFs({ handle: root })

    await store.put('acme', 'invoices', 'inv-1', envelope)

    expect(root.peek('acme/invoices/inv-1.json')).toBe(JSON.stringify(envelope, null, 2))
  })

  test('pretty: false writes compact JSON', async () => {
    const root = fakeRoot()
    const store = toBrowserFs({ handle: root, pretty: false })

    await store.put('acme', 'invoices', 'inv-1', envelope)

    expect(root.peek('acme/invoices/inv-1.json')).toBe(JSON.stringify(envelope))
  })

  test('reads back an envelope a to-file process left behind', async () => {
    const root = fakeRoot()
    root.plant('acme/invoices/inv-9.json', JSON.stringify(envelope, null, 2))
    const store = toBrowserFs({ handle: root })

    expect(await store.get('acme', 'invoices', 'inv-9')).toEqual(envelope)
  })

  test('loadAll skips underscore-prefixed collections, as to-file does', async () => {
    const root = fakeRoot()
    const store = toBrowserFs({ handle: root })
    await store.put('acme', 'invoices', 'inv-1', envelope)
    root.plant('acme/_keyring/user-1.json', JSON.stringify(envelope))
    root.plant('acme/_sync/meta.json', JSON.stringify(envelope))

    expect(Object.keys(await store.loadAll('acme'))).toEqual(['invoices'])
  })
})
