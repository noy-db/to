import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { StoreCredentials } from '@noy-db/hub/to'

// #479 credential-broker adoption — `credentials?: StoreCredentialSource` on
// `DynamoOptions`, threaded into getClient()'s SDK config as a functional
// provider. `mapAws` is the pure aws-shape mapper; the wiring tests prove
// getClient() actually passes that provider into the SDK config (vs. only
// being accepted and ignored).

describe('to-aws-dynamo — credentials refresh hook', () => {
  describe('mapAws', () => {
    it('maps aws credentials with expiresAt to an identity whose expiration is a Date at the right epoch', async () => {
      const { mapAws } = await import('../src/index.js')
      const creds: StoreCredentials = {
        kind: 'aws',
        accessKeyId: 'AKIA_TEST',
        secretAccessKey: 'secret',
        expiresAt: '2026-07-14T12:00:00.000Z',
      }
      const id = mapAws(creds)
      expect(id.accessKeyId).toBe('AKIA_TEST')
      expect(id.secretAccessKey).toBe('secret')
      expect(id.expiration).toBeInstanceOf(Date)
      expect(id.expiration?.getTime()).toBe(new Date('2026-07-14T12:00:00.000Z').getTime())
    })

    it('omits the expiration key entirely when expiresAt is absent (SDK memoize-forever guard)', async () => {
      const { mapAws } = await import('../src/index.js')
      const creds: StoreCredentials = {
        kind: 'aws',
        accessKeyId: 'AKIA_TEST',
        secretAccessKey: 'secret',
      }
      const id = mapAws(creds)
      expect('expiration' in id).toBe(false)
    })

    it('includes sessionToken when present and omits the key when absent', async () => {
      const { mapAws } = await import('../src/index.js')
      const withToken = mapAws({ kind: 'aws', accessKeyId: 'a', secretAccessKey: 's', sessionToken: 'tok' })
      expect(withToken.sessionToken).toBe('tok')

      const withoutToken = mapAws({ kind: 'aws', accessKeyId: 'a', secretAccessKey: 's' })
      expect('sessionToken' in withoutToken).toBe(false)
    })

    it('rejects a non-aws credential kind (dynamo is SigV4-only)', async () => {
      const { mapAws } = await import('../src/index.js')
      expect(() => mapAws({ kind: 'token', token: 'xyz' } as unknown as StoreCredentials)).toThrow()
    })
  })

  describe('getClient() wiring', () => {
    beforeEach(() => {
      vi.resetModules()
    })

    it('threads a functional credentials provider into the SDK client config when `credentials` is supplied', async () => {
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

      const { toAwsDynamo } = await import('../src/index.js')
      const creds: StoreCredentials = {
        kind: 'aws',
        accessKeyId: 'a',
        secretAccessKey: 's',
        expiresAt: '2026-07-14T12:00:00.000Z',
      }
      const adapter = toAwsDynamo({ table: 't', credentials: async () => creds })

      // Any operation forces getClient() to build the SDK config.
      await adapter.ping().catch(() => {})

      expect(capturedConfigs).toHaveLength(1)
      const config = capturedConfigs[0]
      expect(typeof config['credentials']).toBe('function')

      const resolved = await (config['credentials'] as () => Promise<{ accessKeyId: string; expiration?: Date }>)()
      expect(resolved.accessKeyId).toBe('a')
      expect(resolved.expiration).toBeInstanceOf(Date)

      vi.doUnmock('@aws-sdk/client-dynamodb')
      vi.doUnmock('@aws-sdk/lib-dynamodb')
    })

    it('omits the credentials key from config when the option is not supplied (ambient chain preserved)', async () => {
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

      const { toAwsDynamo } = await import('../src/index.js')
      const adapter = toAwsDynamo({ table: 't' })
      await adapter.ping().catch(() => {})

      expect(capturedConfigs).toHaveLength(1)
      expect('credentials' in capturedConfigs[0]).toBe(false)

      vi.doUnmock('@aws-sdk/client-dynamodb')
      vi.doUnmock('@aws-sdk/lib-dynamodb')
    })

    it('does not touch the pre-built `client` short-circuit path even when `credentials` is also supplied', async () => {
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
      }))

      const { toAwsDynamo } = await import('../src/index.js')
      const fakeClient = { send: async () => ({ Items: [] }) }
      const adapter = toAwsDynamo({
        table: 't',
        client: fakeClient,
        credentials: async () => ({ kind: 'aws', accessKeyId: 'a', secretAccessKey: 's' }),
      })
      await adapter.ping()

      // getClient() must short-circuit on options.client and never build config.
      expect(capturedConfigs).toHaveLength(0)

      vi.doUnmock('@aws-sdk/client-dynamodb')
      vi.doUnmock('@aws-sdk/lib-dynamodb')
    })
  })
})
