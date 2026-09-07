import { describe, expect, test } from 'vitest'
import { ConflictError } from '@noy-db/hub/to'
import { fakeRoot } from './fake-fs.js'
import { toBrowserFs, FsWriteVerifyError } from '../src/index.js'

const envelope = { _v: 1, _ts: '2026-08-11T00:00:00.000Z', _data: 'Y2lwaGVydGV4dA==' }

describe('verify after write', () => {
  test('throws FsWriteVerifyError when the bytes read back differ', async () => {
    const root = fakeRoot()
    root.volume.corruptWrite = (_path, data) => data.slice(0, 10) // silent short write
    const store = toBrowserFs({ handle: root })

    await expect(store.put('acme', 'invoices', 'inv-1', envelope)).rejects.toThrow(FsWriteVerifyError)
  })

  test('accepts a write whose bytes read back intact', async () => {
    const store = toBrowserFs({ handle: fakeRoot() })

    await expect(store.put('acme', 'invoices', 'inv-1', envelope)).resolves.toBeUndefined()
  })

  test('verifyWrites: false skips the read-back', async () => {
    const root = fakeRoot()
    root.volume.corruptWrite = (_path, data) => data.slice(0, 10)
    const store = toBrowserFs({ handle: root, verifyWrites: false })

    await expect(store.put('acme', 'invoices', 'inv-1', envelope)).resolves.toBeUndefined()
  })

  test('saveAll verifies too', async () => {
    const root = fakeRoot()
    root.volume.corruptWrite = (_path, data) => data.slice(0, 10)
    const store = toBrowserFs({ handle: root })

    await expect(store.saveAll('acme', { invoices: { 'inv-1': envelope } }))
      .rejects.toThrow(FsWriteVerifyError)
  })
})

describe('.crswap orphans', () => {
  // A tab killed mid-write leaves Chromium's swap sidecar behind. The target
  // file is never torn — but the sidecar must stay invisible to the store.
  test('are excluded from list', async () => {
    const root = fakeRoot()
    const store = toBrowserFs({ handle: root })
    await store.put('acme', 'invoices', 'inv-1', envelope)
    root.plant('acme/invoices/inv-2.json.crswap', '{"partial"')

    expect(await store.list('acme', 'invoices')).toEqual(['inv-1'])
  })

  test('are excluded from loadAll', async () => {
    const root = fakeRoot()
    const store = toBrowserFs({ handle: root })
    await store.put('acme', 'invoices', 'inv-1', envelope)
    root.plant('acme/invoices/inv-2.json.crswap', '{"partial"')

    expect(Object.keys((await store.loadAll('acme')).invoices!)).toEqual(['inv-1'])
  })

  test('are excluded from listPage', async () => {
    const root = fakeRoot()
    const store = toBrowserFs({ handle: root })
    await store.put('acme', 'invoices', 'inv-1', envelope)
    root.plant('acme/invoices/inv-2.json.crswap', '{"partial"')

    expect((await store.listPage!('acme', 'invoices')).items).toEqual([
      { id: 'inv-1', envelope },
    ])
  })
})

describe('compare-and-set', () => {
  test('rejects a put whose expectedVersion does not match what is on disk', async () => {
    const store = toBrowserFs({ handle: fakeRoot() })
    await store.put('acme', 'invoices', 'inv-1', { ...envelope, _v: 3 })

    await expect(store.put('acme', 'invoices', 'inv-1', { ...envelope, _v: 4 }, 2))
      .rejects.toThrow(ConflictError)
  })

  test('accepts a put whose expectedVersion matches', async () => {
    const store = toBrowserFs({ handle: fakeRoot() })
    await store.put('acme', 'invoices', 'inv-1', { ...envelope, _v: 3 })

    await expect(store.put('acme', 'invoices', 'inv-1', { ...envelope, _v: 4 }, 3))
      .resolves.toBeUndefined()
  })

  test('declares casAtomic false, so the hub refuses to mint sequences here', async () => {
    const store = toBrowserFs({ handle: fakeRoot() })

    expect(store.capabilities?.casAtomic).toBe(false)
  })
})
