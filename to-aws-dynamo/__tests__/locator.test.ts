import { describe, expect, it, vi, beforeEach } from 'vitest'
import type { StoreCredentials } from '@noy-db/hub/to'
import { createStoreLocator } from '@noy-db/hub/to'
import { runStoreConformanceTests } from '@noy-db/test-adapter-conformance'
import { registerDynamoStore, dynamoStoreDescriptor } from '../src/index.js'
import { fakeDynamo } from './_fake-dynamo.js'

// noy-db-to#58 — `cloud` class; the document client rides the device-local
// `binding` slot, AWS credentials ride the broker seam. Neither touches the
// descriptor.

describe('to-aws-dynamo — store-locator descriptor (#58)', () => {
  it('resolves a working NoydbStore from a descriptor', async () => {
    const locator = createStoreLocator()
    registerDynamoStore(locator)
    const descriptor = dynamoStoreDescriptor({ table: 'locator' })
    const store = await locator.resolve(descriptor, { binding: { client: fakeDynamo().client } })
    const envelope = { _noydb: 1 as const, _v: 1, _ts: new Date().toISOString(), _iv: 'i', _data: 'ZA==' }
    await store.put('v', 'c', 'a', envelope)
    expect((await store.get('v', 'c', 'a'))?._v).toBe(1)
  })

  it('descriptor is JSON-serializable and credentialless by construction', () => {
    const descriptor = dynamoStoreDescriptor({ table: 't', region: 'eu-west-1', endpoint: 'http://localhost:8000' })
    expect(JSON.parse(JSON.stringify(descriptor))).toEqual(descriptor)
    expect(descriptor).toEqual({
      kind: 'aws-dynamo',
      class: 'cloud',
      address: { table: 't', region: 'eu-west-1', endpoint: 'http://localhost:8000' },
    })
  })

  it('an unregistered kind fails resolve loudly', () => {
    const locator = createStoreLocator()
    expect(() => locator.resolve(dynamoStoreDescriptor({ table: 't' }))).toThrow()
  })

  it('forwards the descriptor address into the commands the store actually sends (#58)', async () => {
    const locator = createStoreLocator()
    registerDynamoStore(locator)
    const fake = fakeDynamo()
    const seenTableNames: string[] = []
    const spyClient = {
      async send(command: unknown) {
        const input = (command as { input: { TableName?: string } }).input
        if (input?.TableName !== undefined) seenTableNames.push(input.TableName)
        return fake.client.send(command)
      },
    }
    const descriptor = dynamoStoreDescriptor({ table: 'custom-locator-table' })
    const store = await locator.resolve(descriptor, { binding: { client: spyClient } })
    const envelope = { _noydb: 1 as const, _v: 1, _ts: new Date().toISOString(), _iv: 'i', _data: 'ZA==' }
    await store.put('v', 'c', 'a', envelope)
    expect(seenTableNames).toContain('custom-locator-table')
  })

  describe('credentials path (broker seam #479)', () => {
    beforeEach(() => {
      vi.resetModules()
    })

    it('threads a StoreCredentialSource from resolve() options into the store', async () => {
      // Capture SDK config to verify credentials function was threaded
      const capturedConfigs: Record<string, unknown>[] = []
      vi.doMock('@aws-sdk/client-dynamodb', () => ({
        DynamoDBClient: class {
          constructor(config: Record<string, unknown>) {
            capturedConfigs.push(config)
          }
        },
      }))
      vi.doMock('@aws-sdk/lib-dynamodb', () => ({
        DynamoDBDocumentClient: { from: (client: unknown) => client },
        QueryCommand: class { constructor(public input: unknown) {} },
      }))

      // Use fresh imports after mocking
      const { createStoreLocator: createLocator } = await import('@noy-db/hub/to')
      const { registerDynamoStore: registerStore, dynamoStoreDescriptor: descriptor } = await import('../src/index.js')

      const locator = createLocator()
      registerStore(locator)

      const creds: StoreCredentials = {
        kind: 'aws',
        accessKeyId: 'AKIA_TEST_LOCATOR',
        secretAccessKey: 'secret',
        expiresAt: '2026-08-04T12:00:00.000Z',
      }

      // Resolve WITHOUT binding.client (so SDK path is exercised, not the pre-built shortcut)
      const store = locator.resolve(descriptor({ table: 'cred-test' }), {
        credentials: async () => creds,
      })

      // Force getClient() to build SDK config by calling an operation
      await (await store).ping().catch(() => {})

      // Verify SDK constructor was called with a credentials function
      expect(capturedConfigs).toHaveLength(1)
      const config = capturedConfigs[0]
      expect(typeof config['credentials']).toBe('function')

      // Verify the credentials function works
      const resolved = await (config['credentials'] as () => Promise<{ accessKeyId: string; expiration?: Date }>)()
      expect(resolved.accessKeyId).toBe('AKIA_TEST_LOCATOR')
      expect(resolved.expiration).toBeInstanceOf(Date)

      vi.doUnmock('@aws-sdk/client-dynamodb')
      vi.doUnmock('@aws-sdk/lib-dynamodb')
    })
  })
})

// ─── Full conformance suite against a descriptor-resolved store ──────
runStoreConformanceTests('to-aws-dynamo (descriptor-resolved via store locator)', async () => {
  const locator = createStoreLocator()
  registerDynamoStore(locator)
  return locator.resolve(dynamoStoreDescriptor({ table: 'conformance' }), {
    binding: { client: fakeDynamo().client },
  })
})

// ─── noy-db-to#69 — descriptor.options may only set declared keys ─────
//
// This store declares NO `DescriptorOptions` at all, so its factory never
// read `descriptor.options` — but it did spread `...address` wholesale,
// which is the same unchecked cast. Both are now named-field only.

describe('to-aws-dynamo — descriptor cannot smuggle undeclared keys (#69)', () => {
  it('an options bag is ignored entirely — this store declares none', async () => {
    const locator = createStoreLocator()
    registerDynamoStore(locator)
    const fake = fakeDynamo()
    const store = await locator.resolve(
      { ...dynamoStoreDescriptor({ table: 'noydb' }), options: { table: 'attacker_owned', nonsense: true } },
      { binding: { client: fake.client } },
    )
    const envelope = { _noydb: 1 as const, _v: 1, _ts: new Date().toISOString(), _iv: 'i', _data: 'ZA==' }
    await store.put('v', 'c', 'a', envelope)
    expect((await store.get('v', 'c', 'a'))?._v).toBe(1)
  })

  it('an undeclared address key never reaches the store', async () => {
    const locator = createStoreLocator()
    registerDynamoStore(locator)
    const fake = fakeDynamo()
    const store = await locator.resolve(
      { ...dynamoStoreDescriptor({ table: 'noydb' }), address: { table: 'noydb', nonsense: true } },
      { binding: { client: fake.client } },
    )
    const envelope = { _noydb: 1 as const, _v: 1, _ts: new Date().toISOString(), _iv: 'i', _data: 'ZA==' }
    await store.put('v', 'c', 'a', envelope)
    expect((await store.get('v', 'c', 'a'))?._v).toBe(1)
  })
})
