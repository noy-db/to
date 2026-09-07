import 'fake-indexeddb/auto'
import { beforeEach, describe, expect, test } from 'vitest'
import { fakeRoot } from './fake-fs.js'
import { rememberDirectory, recallDirectory, forgetDirectory } from '../src/index.js'

describe('handle persistence', () => {
  beforeEach(async () => {
    await forgetDirectory('lan-share')
    await forgetDirectory('usb-stick')
  })

  // IndexedDB structured-clones what it stores, so a recalled handle is a
  // new object referring to the same directory — never the object you put
  // in. Compare with `isSameEntry()` in a browser, not with `===`.
  test('recalls a handle stored under a key', async () => {
    await rememberDirectory('lan-share', fakeRoot({}, 'Z-drive'))

    expect((await recallDirectory('lan-share'))?.name).toBe('Z-drive')
  })

  test('returns null for a key never stored', async () => {
    expect(await recallDirectory('never-picked')).toBeNull()
  })

  test('forgetting a key drops the handle', async () => {
    await rememberDirectory('lan-share', fakeRoot())

    await forgetDirectory('lan-share')

    expect(await recallDirectory('lan-share')).toBeNull()
  })

  test('keys are independent', async () => {
    await rememberDirectory('lan-share', fakeRoot({}, 'Z-drive'))
    await rememberDirectory('usb-stick', fakeRoot({}, 'E-drive'))

    expect((await recallDirectory('lan-share'))?.name).toBe('Z-drive')
    expect((await recallDirectory('usb-stick'))?.name).toBe('E-drive')
  })
})
