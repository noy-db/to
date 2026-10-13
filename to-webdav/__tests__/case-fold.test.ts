import { describe, expect, it } from 'vitest'
import { toWebdav } from '../src/index.js'
import { fakeDav } from './_fake-dav.js'

const env = (data: string) => ({ _noydb: 1 as const, _v: 1, _ts: '2026-10-14T00:00:00.000Z', _iv: 'aaaa', _data: data })
const baseUrl = 'https://dav.example.com'

describe('to-webdav on a case-folding server (family#215)', () => {
  it('refuses an id that differs from an existing record only by case', async () => {
    const store = toWebdav({ baseUrl, fetch: fakeDav({ foldCase: true }).fetch })
    await store.put('v', 'c', 'Abc', env('upper'))

    await expect(store.put('v', 'c', 'abc', env('lower'))).rejects.toThrow(/case-folds onto the existing "Abc"/)
    expect((await store.get('v', 'c', 'Abc'))?._data).toBe('upper')
    expect(await store.list('v', 'c')).toEqual(['Abc'])
  })

  it('refuses a folded collection component too (`_idx/name` against `_idx/Name`)', async () => {
    const store = toWebdav({ baseUrl, fetch: fakeDav({ foldCase: true }).fetch })
    await store.put('v', 'c', '_idx/Name/x', env('x'))

    await expect(store.put('v', 'c', '_idx/name/y', env('y'))).rejects.toThrow(/case-folds onto the existing "_idx\/Name"/)
    expect(await store.list('v', 'c')).toEqual(['_idx/Name/x'])
  })

  it('saveAll refuses too, rather than letting its prune delete the snapshot\'s own record', async () => {
    const store = toWebdav({ baseUrl, fetch: fakeDav({ foldCase: true }).fetch })
    await store.put('v', 'c', 'Abc', env('upper'))

    await expect(store.saveAll('v', { c: { abc: env('lower') } })).rejects.toThrow(/case-folds onto the existing "Abc"/)
    expect((await store.get('v', 'c', 'Abc'))?._data).toBe('upper')
  })

  it('rewrites the same id in its own spelling', async () => {
    const store = toWebdav({ baseUrl, fetch: fakeDav({ foldCase: true }).fetch })
    await store.put('v', 'c', 'Abc', env('one'))
    await store.put('v', 'c', 'Abc', env('two'))
    expect((await store.get('v', 'c', 'Abc'))?._data).toBe('two')
  })

  it('leaves no probe file behind, with or without a prefix', async () => {
    for (const prefix of ['', 'noydb']) {
      const dav = fakeDav({ foldCase: true })
      const store = toWebdav({ baseUrl, prefix, fetch: dav.fetch })
      await store.put('v', 'c', 'a', env('a'))
      expect([...dav.files.keys()].filter(f => f.includes('noydb-case-probe'))).toEqual([])
    }
  })

  it('does not cache a failed probe as "case-sensitive": the next write probes again', async () => {
    const dav = fakeDav({ foldCase: true })
    let failProbe = true
    const flaky = (async (url: unknown, init?: { method?: string }) => {
      if (failProbe && String(url).includes('noydb-case-probe') && init?.method === 'PUT') {
        failProbe = false
        return new Response(null, { status: 503 })
      }
      return dav.fetch(url as string, init as RequestInit)
    }) as unknown as typeof fetch
    const store = toWebdav({ baseUrl, fetch: flaky })

    await expect(store.put('v', 'c', 'Abc', env('upper'))).rejects.toThrow(/case probe/)
    await store.put('v', 'c', 'Abc', env('upper'))
    await expect(store.put('v', 'c', 'abc', env('lower'))).rejects.toThrow(/case-folds/)
  })
})

describe('to-webdav on a case-sensitive server (family#215)', () => {
  it('keeps "Abc" and "abc" as two records', async () => {
    const store = toWebdav({ baseUrl, fetch: fakeDav().fetch })
    await store.put('v', 'c', 'Abc', env('upper'))
    await store.put('v', 'c', 'abc', env('lower'))
    expect((await store.list('v', 'c')).sort()).toEqual(['Abc', 'abc'])
  })
})
