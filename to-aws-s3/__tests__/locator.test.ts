import { describe, expect, it } from 'vitest'
import { createStoreLocator } from '@noy-db/hub/to'
import { runStoreConformanceTests } from '@noy-db/test-adapter-conformance'
import { registerS3Store, s3StoreDescriptor } from '../src/index.js'
import { fakeS3 } from './_fake-s3.js'

// noy-db-to#56 / noy-db#945 — the `cloud`-class reference: a
// credentialless, JSON-serializable descriptor reconstructs the store via
// the locator; credentials arrive via StoreCredentialSource at resolve
// time, and a pre-built client (test fake, custom middleware) rides the
// device-local `binding` slot.

describe('to-aws-s3 — store-locator descriptor (#56)', () => {
  it('resolves a working NoydbStore from a descriptor', async () => {
    const locator = createStoreLocator()
    registerS3Store(locator)
    const descriptor = s3StoreDescriptor({ bucket: 'b', region: 'eu-central-1', prefix: 'noydb' })
    const store = await locator.resolve(descriptor, { binding: { client: fakeS3().client } })
    const envelope = { _noydb: 1 as const, _v: 1, _ts: new Date().toISOString(), _iv: 'i', _data: 'ZA==' }
    await store.put('v', 'c', 'a', envelope)
    expect((await store.get('v', 'c', 'a'))?._v).toBe(1)
  })

  it('descriptor is JSON-serializable and credentialless by construction', () => {
    const descriptor = s3StoreDescriptor({ bucket: 'b', region: 'us-east-1' }, { clockUncertaintyMs: 2000 })
    expect(JSON.parse(JSON.stringify(descriptor))).toEqual(descriptor)
    expect(descriptor).toEqual({
      kind: 'aws-s3',
      class: 'cloud',
      address: { bucket: 'b', region: 'us-east-1' },
      options: { clockUncertaintyMs: 2000 },
    })
  })

  it('an unregistered kind fails resolve loudly', () => {
    const locator = createStoreLocator()
    expect(() => locator.resolve(s3StoreDescriptor({ bucket: 'b' }))).toThrow()
  })

  it('forwards the descriptor address into the commands the store actually sends (#58)', async () => {
    const locator = createStoreLocator()
    registerS3Store(locator)
    const fake = fakeS3()
    const seenCommands: { name: string; Bucket?: unknown; Key?: unknown }[] = []
    const spyClient = {
      async send(command: unknown) {
        const name = (command as { constructor: { name: string } }).constructor.name
        const input = (command as { input: Record<string, unknown> }).input
        seenCommands.push({ name, Bucket: input.Bucket, Key: input.Key })
        return fake.client.send(command as never)
      },
    } as typeof fake.client
    const descriptor = s3StoreDescriptor({ bucket: 'custom-bucket', prefix: 'custom-prefix' })
    const store = await locator.resolve(descriptor, { binding: { client: spyClient } })
    const envelope = { _noydb: 1 as const, _v: 1, _ts: new Date().toISOString(), _iv: 'i', _data: 'ZA==' }
    await store.put('v', 'c', 'a', envelope)
    const putCmd = seenCommands.find(c => c.name === 'PutObjectCommand')
    expect(putCmd?.Bucket).toBe('custom-bucket')
    expect(putCmd?.Key).toBe('custom-prefix/v/c/a.json')
  })
})

// ─── Full conformance suite against a descriptor-resolved store ──────
runStoreConformanceTests('to-aws-s3 (descriptor-resolved via store locator)', async () => {
  const locator = createStoreLocator()
  registerS3Store(locator)
  return locator.resolve(s3StoreDescriptor({ bucket: 'b' }), { binding: { client: fakeS3().client } })
})

// ─── noy-db-to#69 — descriptor.options may only set declared keys ─────
//
// The factory used to build its store options as `{ ...address, ...options }`,
// so ANY key in the unchecked `options` bag won over the same key in
// `address`. `prefix` is the sharpest case: a plain string that survives a
// pod round-trip intact, and the thing that decides where objects land.

describe('to-aws-s3 — descriptor.options cannot shadow address-owned slots (#69)', () => {
  it('a prefix smuggled through options never overrides the address prefix', async () => {
    const locator = createStoreLocator()
    registerS3Store(locator)
    const client = fakeS3().client
    const poisoned = await locator.resolve(
      { ...s3StoreDescriptor({ bucket: 'b', prefix: 'tenant-a' }), options: { prefix: 'attacker' } },
      { binding: { client } },
    )
    const clean = await locator.resolve(s3StoreDescriptor({ bucket: 'b', prefix: 'tenant-a' }), { binding: { client } })
    const envelope = { _noydb: 1 as const, _v: 1, _ts: new Date().toISOString(), _iv: 'i', _data: 'ZA==' }
    await poisoned.put('v', 'c', 'a', envelope)
    // Both stores agree on `tenant-a/` ⇒ the shadow never landed.
    expect((await clean.get('v', 'c', 'a'))?._v).toBe(1)
  })

  it('an unknown options key is ignored, not forwarded', async () => {
    const locator = createStoreLocator()
    registerS3Store(locator)
    const store = await locator.resolve(
      { ...s3StoreDescriptor({ bucket: 'b' }), options: { nonsense: true } },
      { binding: { client: fakeS3().client } },
    )
    const envelope = { _noydb: 1 as const, _v: 1, _ts: new Date().toISOString(), _iv: 'i', _data: 'ZA==' }
    await store.put('v', 'c', 'a', envelope)
    expect((await store.get('v', 'c', 'a'))?._v).toBe(1)
  })
})
