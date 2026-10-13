import { describe, expect, test } from 'vitest'
import { fakeRoot } from './fake-fs.js'
import { toBrowserFs } from '../src/index.js'

const env = (data: string) => ({ _noydb: 1 as const, _v: 1, _ts: '2026-10-14T00:00:00.000Z', _iv: 'AAAAAAAAAAAAAAAA', _data: data })

describe('on a case-folding volume (family#215)', () => {
  test('refuses an id that differs from an existing record only by case', async () => {
    const store = toBrowserFs({ handle: fakeRoot({ foldCase: true }) })
    await store.put('acme', 'invoices', 'Abc', env('upper'))

    await expect(store.put('acme', 'invoices', 'abc', env('lower'))).rejects.toThrow(/case-folds onto the existing "Abc"/)
    expect((await store.get('acme', 'invoices', 'Abc'))?._data).toBe('upper')
    expect(await store.list('acme', 'invoices')).toEqual(['Abc'])
  })

  test('saveAll refuses too, rather than letting its prune delete the snapshot\'s own record', async () => {
    const store = toBrowserFs({ handle: fakeRoot({ foldCase: true }) })
    await store.put('acme', 'invoices', 'Abc', env('upper'))

    await expect(store.saveAll('acme', { invoices: { abc: env('lower') } })).rejects.toThrow(/case-folds onto the existing "Abc"/)
    expect((await store.get('acme', 'invoices', 'Abc'))?._data).toBe('upper')
  })

  test('rewrites the same id in its own spelling', async () => {
    const store = toBrowserFs({ handle: fakeRoot({ foldCase: true }) })
    await store.put('acme', 'invoices', 'Abc', env('one'))
    await store.put('acme', 'invoices', 'Abc', env('two'))
    expect((await store.get('acme', 'invoices', 'Abc'))?._data).toBe('two')
  })

  test('leaves no probe file behind', async () => {
    const root = fakeRoot({ foldCase: true })
    await toBrowserFs({ handle: root }).put('acme', 'invoices', 'a', env('a'))
    expect(root.paths()).toEqual(['acme/invoices/a.json'])
  })

  test('never probes before a write, so the store still never prompts', async () => {
    const root = fakeRoot({ permission: 'prompt', foldCase: true })
    const store = toBrowserFs({ handle: root })
    expect(await store.access()).toBe('prompt')
    expect(root.volume.requests).toBe(0)
    expect(root.paths()).toEqual([])
  })

  test('does not cache a failed probe as "case-sensitive": the next write probes again', async () => {
    const root = fakeRoot({ foldCase: true })
    const getFileHandle = root.getFileHandle.bind(root)
    let failProbe = true
    root.getFileHandle = async (name, options) => {
      if (failProbe && name.startsWith('.noydb-case-probe')) {
        failProbe = false
        throw new DOMException('The share stopped answering.', 'NotReadableError')
      }
      return getFileHandle(name, options)
    }
    const store = toBrowserFs({ handle: root })

    await expect(store.put('acme', 'invoices', 'Abc', env('upper'))).rejects.toThrow(/stopped answering/)
    await store.put('acme', 'invoices', 'Abc', env('upper'))
    await expect(store.put('acme', 'invoices', 'abc', env('lower'))).rejects.toThrow(/case-folds/)
  })
})

describe('on a case-sensitive volume (family#215)', () => {
  test('keeps "Abc" and "abc" as two records', async () => {
    const store = toBrowserFs({ handle: fakeRoot() })
    await store.put('acme', 'invoices', 'Abc', env('upper'))
    await store.put('acme', 'invoices', 'abc', env('lower'))
    expect(await store.list('acme', 'invoices')).toEqual(['Abc', 'abc'])
  })
})
