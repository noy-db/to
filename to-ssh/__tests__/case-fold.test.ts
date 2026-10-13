import { describe, expect, it } from 'vitest'
import { toSsh } from '../src/index.js'
import { mockSftp } from './_mock.js'

const env = (data: string) => ({ _noydb: 1 as const, _v: 1, _ts: '2026-10-14T00:00:00.000Z', _iv: 'aaaa', _data: data })

describe('to-ssh on a case-folding share (family#215)', () => {
  it('refuses an id that differs from an existing record only by case', async () => {
    const store = toSsh({ sftp: mockSftp({ foldCase: true }) })
    await store.put('v', 'c', 'Abc', env('upper'))

    await expect(store.put('v', 'c', 'abc', env('lower'))).rejects.toThrow(/case-folds onto the existing "Abc"/)
    expect((await store.get('v', 'c', 'Abc'))?._data).toBe('upper')
    expect(await store.list('v', 'c')).toEqual(['Abc'])
  })

  it('refuses a folded DIRECTORY component too (`_idx/name` against `_idx/Name`)', async () => {
    const store = toSsh({ sftp: mockSftp({ foldCase: true }) })
    await store.put('v', 'c', '_idx/Name/x', env('x'))

    await expect(store.put('v', 'c', '_idx/name/y', env('y'))).rejects.toThrow(/case-folds onto the existing "_idx\/Name"/)
    expect(await store.list('v', 'c')).toEqual(['_idx/Name/x'])
  })

  it('saveAll refuses too, rather than letting its prune delete the snapshot\'s own record', async () => {
    const store = toSsh({ sftp: mockSftp({ foldCase: true }) })
    await store.put('v', 'c', 'Abc', env('upper'))

    await expect(store.saveAll('v', { c: { abc: env('lower') } })).rejects.toThrow(/case-folds onto the existing "Abc"/)
    expect((await store.get('v', 'c', 'Abc'))?._data).toBe('upper')
  })

  it('rewrites the same id in its own spelling', async () => {
    const store = toSsh({ sftp: mockSftp({ foldCase: true }) })
    await store.put('v', 'c', 'Abc', env('one'))
    await store.put('v', 'c', 'Abc', env('two'))
    expect((await store.get('v', 'c', 'Abc'))?._data).toBe('two')
  })

  it('leaves no probe file behind', async () => {
    const handle = mockSftp({ foldCase: true })
    const store = toSsh({ sftp: handle })
    await store.put('v', 'c', 'a', env('a'))
    expect([...handle.files.keys()].filter(f => f.includes('noydb-case-probe'))).toEqual([])
  })

  it('does not cache a failed probe as "case-sensitive": the next write probes again', async () => {
    const handle = mockSftp({ foldCase: true })
    const writeFile = handle.writeFile.bind(handle)
    let failProbe = true
    handle.writeFile = async (path, data) => {
      if (failProbe && path.includes('noydb-case-probe')) {
        failProbe = false
        throw new Error('share went away')
      }
      return writeFile(path, data)
    }
    const store = toSsh({ sftp: handle })

    await expect(store.put('v', 'c', 'Abc', env('upper'))).rejects.toThrow(/share went away/)
    await store.put('v', 'c', 'Abc', env('upper'))
    await expect(store.put('v', 'c', 'abc', env('lower'))).rejects.toThrow(/case-folds/)
  })
})

describe('to-ssh on a case-sensitive share (family#215)', () => {
  it('keeps "Abc" and "abc" as two records', async () => {
    const store = toSsh({ sftp: mockSftp() })
    await store.put('v', 'c', 'Abc', env('upper'))
    await store.put('v', 'c', 'abc', env('lower'))
    expect((await store.list('v', 'c')).sort()).toEqual(['Abc', 'abc'])
  })
})
