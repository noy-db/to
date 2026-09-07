import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { StoreCredentials } from '@noy-db/hub/to'

// #479 credential-broker adoption — `credentials?: StoreCredentialSource` on
// BOTH `S3Options` (toAwsS3()) and `S3BundleOptions` (s3Bundle()), threaded into
// each site's `new S3Client({...})` as a functional provider. `mapAws` is a
// SHARED pure aws-shape mapper (to-aws-s3/src/credentials.ts) used by both
// factories. Unlike to-aws-dynamo's lazy client, toAwsS3()/s3Bundle() build their
// S3Client EAGERLY and SYNCHRONOUSLY inside the factory call itself — no
// operation call is needed to force construction.

describe('to-aws-s3 — credentials refresh hook', () => {
  describe('mapAws (shared)', () => {
    it('maps aws credentials with expiresAt to an identity whose expiration is a Date at the right epoch', async () => {
      const { mapAws } = await import('../src/credentials.js')
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
      const { mapAws } = await import('../src/credentials.js')
      const creds: StoreCredentials = {
        kind: 'aws',
        accessKeyId: 'AKIA_TEST',
        secretAccessKey: 'secret',
      }
      const id = mapAws(creds)
      expect('expiration' in id).toBe(false)
    })

    it('includes sessionToken when present and omits the key when absent', async () => {
      const { mapAws } = await import('../src/credentials.js')
      const withToken = mapAws({ kind: 'aws', accessKeyId: 'a', secretAccessKey: 's', sessionToken: 'tok' })
      expect(withToken.sessionToken).toBe('tok')

      const withoutToken = mapAws({ kind: 'aws', accessKeyId: 'a', secretAccessKey: 's' })
      expect('sessionToken' in withoutToken).toBe(false)
    })

    it('rejects a non-aws credential kind (S3 SigV4 is aws-only)', async () => {
      const { mapAws } = await import('../src/credentials.js')
      expect(() => mapAws({ kind: 'token', token: 'xyz' } as unknown as StoreCredentials)).toThrow()
    })
  })

  describe('package barrel', () => {
    it('re-exports mapAws so sibling S3-compatible stores (to-cloudflare-r2) can share it', async () => {
      const barrel = await import('../src/index.js')
      expect(typeof barrel.mapAws).toBe('function')
      const id = barrel.mapAws({ kind: 'aws', accessKeyId: 'a', secretAccessKey: 's' })
      expect(id.accessKeyId).toBe('a')
    })
  })

  describe('toAwsS3() client construction wiring', () => {
    beforeEach(() => {
      vi.resetModules()
    })

    it('threads a functional credentials provider into the S3Client config when `credentials` is supplied', async () => {
      const capturedConfigs: Record<string, unknown>[] = []
      vi.doMock('@aws-sdk/client-s3', () => ({
        S3Client: class {
          constructor(config: Record<string, unknown>) {
            capturedConfigs.push(config)
          }
        },
      }))

      const { toAwsS3 } = await import('../src/index.js')
      const creds: StoreCredentials = {
        kind: 'aws',
        accessKeyId: 'a',
        secretAccessKey: 's',
        expiresAt: '2026-07-14T12:00:00.000Z',
      }
      // toAwsS3() builds its client eagerly and synchronously — no operation call needed.
      toAwsS3({ bucket: 'b', credentials: async () => creds })

      expect(capturedConfigs).toHaveLength(1)
      const config = capturedConfigs[0]
      expect(typeof config['credentials']).toBe('function')

      const resolved = await (config['credentials'] as () => Promise<{ accessKeyId: string; expiration?: Date }>)()
      expect(resolved.accessKeyId).toBe('a')
      expect(resolved.expiration).toBeInstanceOf(Date)

      vi.doUnmock('@aws-sdk/client-s3')
    })

    it('omits the credentials key from config when the option is not supplied (ambient chain preserved)', async () => {
      const capturedConfigs: Record<string, unknown>[] = []
      vi.doMock('@aws-sdk/client-s3', () => ({
        S3Client: class {
          constructor(config: Record<string, unknown>) {
            capturedConfigs.push(config)
          }
        },
      }))

      const { toAwsS3 } = await import('../src/index.js')
      toAwsS3({ bucket: 'b' })

      expect(capturedConfigs).toHaveLength(1)
      expect('credentials' in capturedConfigs[0]).toBe(false)

      vi.doUnmock('@aws-sdk/client-s3')
    })

    it('does not touch the pre-built `client` short-circuit path even when `credentials` is also supplied', async () => {
      const capturedConfigs: Record<string, unknown>[] = []
      vi.doMock('@aws-sdk/client-s3', () => ({
        S3Client: class {
          constructor(config: Record<string, unknown>) {
            capturedConfigs.push(config)
          }
        },
      }))

      const { toAwsS3 } = await import('../src/index.js')
      const fakeClient = { send: async () => ({}) }
      toAwsS3({
        bucket: 'b',
        client: fakeClient as never,
        credentials: async () => ({ kind: 'aws', accessKeyId: 'a', secretAccessKey: 's' }),
      })

      // `options.client ?? new S3Client(...)` must short-circuit before `new S3Client` runs.
      expect(capturedConfigs).toHaveLength(0)

      vi.doUnmock('@aws-sdk/client-s3')
    })
  })

  describe('s3Bundle() client construction wiring', () => {
    beforeEach(() => {
      vi.resetModules()
    })

    it('threads a functional credentials provider into the S3Client config when `credentials` is supplied', async () => {
      const capturedConfigs: Record<string, unknown>[] = []
      vi.doMock('@aws-sdk/client-s3', () => ({
        S3Client: class {
          constructor(config: Record<string, unknown>) {
            capturedConfigs.push(config)
          }
        },
      }))

      const { s3Bundle } = await import('../src/bundle.js')
      const creds: StoreCredentials = {
        kind: 'aws',
        accessKeyId: 'a',
        secretAccessKey: 's',
        expiresAt: '2026-07-14T12:00:00.000Z',
      }
      s3Bundle({ bucket: 'b', credentials: async () => creds })

      expect(capturedConfigs).toHaveLength(1)
      const config = capturedConfigs[0]
      expect(typeof config['credentials']).toBe('function')

      const resolved = await (config['credentials'] as () => Promise<{ accessKeyId: string; expiration?: Date }>)()
      expect(resolved.accessKeyId).toBe('a')
      expect(resolved.expiration).toBeInstanceOf(Date)

      vi.doUnmock('@aws-sdk/client-s3')
    })

    it('omits the credentials key from config when the option is not supplied (ambient chain preserved)', async () => {
      const capturedConfigs: Record<string, unknown>[] = []
      vi.doMock('@aws-sdk/client-s3', () => ({
        S3Client: class {
          constructor(config: Record<string, unknown>) {
            capturedConfigs.push(config)
          }
        },
      }))

      const { s3Bundle } = await import('../src/bundle.js')
      s3Bundle({ bucket: 'b' })

      expect(capturedConfigs).toHaveLength(1)
      expect('credentials' in capturedConfigs[0]).toBe(false)

      vi.doUnmock('@aws-sdk/client-s3')
    })

    it('does not touch the pre-built `client` short-circuit path even when `credentials` is also supplied', async () => {
      const capturedConfigs: Record<string, unknown>[] = []
      vi.doMock('@aws-sdk/client-s3', () => ({
        S3Client: class {
          constructor(config: Record<string, unknown>) {
            capturedConfigs.push(config)
          }
        },
      }))

      const { s3Bundle } = await import('../src/bundle.js')
      const fakeClient = { send: async () => ({}) }
      s3Bundle({
        bucket: 'b',
        client: fakeClient as never,
        credentials: async () => ({ kind: 'aws', accessKeyId: 'a', secretAccessKey: 's' }),
      })

      expect(capturedConfigs).toHaveLength(0)

      vi.doUnmock('@aws-sdk/client-s3')
    })
  })
})
