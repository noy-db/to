import { describe, expect, test } from 'vitest'
import { fakeRoot } from './fake-fs.js'
import { toBrowserFs, FsPermissionError, FsUnreachableError } from '../src/index.js'

const envelope = { _v: 1, _ts: '2026-08-11T00:00:00.000Z', _data: 'Y2lwaGVydGV4dA==' }

describe('access()', () => {
  test('reports granted when permission is held and the volume answers', async () => {
    const store = toBrowserFs({ handle: fakeRoot() })

    expect(await store.access()).toBe('granted')
  })

  test('reports prompt when the grant has lapsed', async () => {
    const store = toBrowserFs({ handle: fakeRoot({ permission: 'prompt' }) })

    expect(await store.access()).toBe('prompt')
  })

  test('reports denied when the user refused', async () => {
    const store = toBrowserFs({ handle: fakeRoot({ permission: 'denied' }) })

    expect(await store.access()).toBe('denied')
  })

  test('reports unreachable when the grant is held but the volume is gone', async () => {
    const store = toBrowserFs({ handle: fakeRoot({ mounted: false }) })

    expect(await store.access()).toBe('unreachable')
  })

  test('does not probe an unmounted volume when permission already decided the answer', async () => {
    // A dead SMB mount can block for seconds. 'prompt' is answerable without
    // touching it, so an unmounted volume must still report 'prompt'.
    const store = toBrowserFs({ handle: fakeRoot({ permission: 'prompt', mounted: false }) })

    expect(await store.access()).toBe('prompt')
  })

  test('never prompts', async () => {
    const root = fakeRoot({ permission: 'prompt' })
    const store = toBrowserFs({ handle: root })

    await store.access()

    expect(root.volume.requests).toBe(0)
  })
})

describe('requestAccess()', () => {
  test('returns true and upgrades the state when the user accepts', async () => {
    const root = fakeRoot({ permission: 'prompt', promptResult: 'granted' })
    const store = toBrowserFs({ handle: root })

    expect(await store.requestAccess()).toBe(true)
    expect(await store.access()).toBe('granted')
  })

  test('returns false when the user declines', async () => {
    const root = fakeRoot({ permission: 'prompt', promptResult: 'denied' })
    const store = toBrowserFs({ handle: root })

    expect(await store.requestAccess()).toBe(false)
  })

  test('is the only method that prompts, so the user gesture is never spent implicitly', async () => {
    const root = fakeRoot()
    const store = toBrowserFs({ handle: root })

    await store.put('acme', 'invoices', 'inv-1', envelope)
    await store.get('acme', 'invoices', 'inv-1')
    await store.list('acme', 'invoices')
    await store.loadAll('acme')
    await store.ping!()

    expect(root.volume.requests).toBe(0)
  })
})

describe('error classification', () => {
  test('a revoked grant surfaces FsPermissionError, not a missing record', async () => {
    const root = fakeRoot()
    const store = toBrowserFs({ handle: root })
    await store.put('acme', 'invoices', 'inv-1', envelope)

    root.volume.permission = 'prompt'

    await expect(store.get('acme', 'invoices', 'inv-1')).rejects.toThrow(FsPermissionError)
  })

  test('an unmounted volume surfaces FsUnreachableError, not a missing record', async () => {
    const root = fakeRoot()
    const store = toBrowserFs({ handle: root })
    await store.put('acme', 'invoices', 'inv-1', envelope)

    root.volume.mounted = false

    await expect(store.get('acme', 'invoices', 'inv-1')).rejects.toThrow(FsUnreachableError)
  })

  test('a missing record with a live root is still just null', async () => {
    const store = toBrowserFs({ handle: fakeRoot() })

    expect(await store.get('acme', 'invoices', 'nope')).toBeNull()
  })

  test('a write to an unmounted volume surfaces FsUnreachableError', async () => {
    const root = fakeRoot({ mounted: false })
    const store = toBrowserFs({ handle: root })

    await expect(store.put('acme', 'invoices', 'inv-1', envelope)).rejects.toThrow(FsUnreachableError)
  })

  test('ping is false when the volume is gone, and never throws', async () => {
    const root = fakeRoot({ mounted: false })
    const store = toBrowserFs({ handle: root })

    expect(await store.ping!()).toBe(false)
  })
})
