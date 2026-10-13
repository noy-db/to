import { describe, expect, test } from 'vitest'
import { fakeRoot } from './fake-fs.js'
import { toBrowserFs } from '../src/index.js'

const envelope = { _noydb: 1 as const, _v: 1, _ts: '2026-08-11T00:00:00.000Z', _iv: 'AAAAAAAAAAAAAAAA', _data: 'Y2lwaGVydGV4dA==' }

/** The 4 KB AppleDouble header macOS writes beside every file on a share without xattrs. */
const APPLEDOUBLE = '\u0000\u0005\u0016\u0007\u0000\u0002\u0000\u0000Mac OS X        '

describe('dot-files beside records (family#205)', () => {
  test('a macOS `._` sidecar is neither listed nor loaded', async () => {
    const root = fakeRoot()
    const store = toBrowserFs({ handle: root })
    await store.put('acme', 'invoices', 'x', envelope)
    root.plant('acme/invoices/._x.json', APPLEDOUBLE)
    root.plant('acme/invoices/.DS_Store.json', APPLEDOUBLE)

    expect(await store.list('acme', 'invoices')).toEqual(['x'])
    expect(await store.loadAll('acme')).toEqual({ invoices: { x: envelope } })
    const page = await store.listPage!('acme', 'invoices', undefined, 10)
    expect(page.items.map(i => i.id)).toEqual(['x'])
  })

  test.each(['.x', '._x', '.', '..'])('refuses the record id %j at every entry point', async (id) => {
    const root = fakeRoot()
    const store = toBrowserFs({ handle: root })

    await expect(store.put('acme', 'invoices', id, envelope)).rejects.toThrow(/must not start with a dot/)
    await expect(store.saveAll('acme', { invoices: { [id]: envelope } })).rejects.toThrow(/must not start with a dot/)
    await expect(store.get('acme', 'invoices', id)).rejects.toThrow(/must not start with a dot/)
    await expect(store.delete('acme', 'invoices', id)).rejects.toThrow(/must not start with a dot/)
    expect(root.paths()).toEqual([])
  })

  test('saveAll refuses before writing anything, not halfway through', async () => {
    const root = fakeRoot()
    const store = toBrowserFs({ handle: root })

    await expect(store.saveAll('acme', { invoices: { good: envelope, '._x': envelope } })).rejects.toThrow(/must not start with a dot/)
    expect(root.paths()).toEqual([])
  })

  test('an id with an inner dot is still an ordinary id', async () => {
    const store = toBrowserFs({ handle: fakeRoot() })
    await store.put('acme', 'invoices', 'inv.1', envelope)
    expect(await store.get('acme', 'invoices', 'inv.1')).toEqual(envelope)
  })
})
