import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { StoreCredentials } from '@noy-db/hub/to'
import { toCloudflareR2 } from '../src/index.js'

// #479 credential-broker adoption for R2 (noy-db-to#10) — `credentials?:
// StoreCredentialSource` on `R2Options`, threaded into the R2-pointed
// `new S3Client({...})` as a functional provider via to-aws-s3's shared
// `mapAws`. R2 keys are S3-compatible, so `kind: 'aws'` maps directly.
// Precedence: pre-built `client` > `credentials`.

const ROLLING: StoreCredentials = {
  kind: 'aws',
  accessKeyId: 'R2_ROLLING_KEY',
  secretAccessKey: 'R2_ROLLING_SECRET',
  expiresAt: '2026-07-20T12:00:00.000Z',
}

describe('to-cloudflare-r2 — credentials refresh hook', () => {
  beforeEach(() => {
    vi.resetModules()
  })

  it('threads a functional credentials provider into the R2 client config (no static keys needed)', async () => {
    const capturedConfigs: Record<string, unknown>[] = []
    vi.doMock('@aws-sdk/client-s3', () => ({
      S3Client: class {
        constructor(config: Record<string, unknown>) {
          capturedConfigs.push(config)
        }
      },
    }))

    const { toCloudflareR2 } = await import('../src/index.js')
    toCloudflareR2({ bucket: 'b', accountId: 'acc', credentials: async () => ROLLING })

    expect(capturedConfigs).toHaveLength(1)
    const config = capturedConfigs[0]
    // R2-specific plumbing must be untouched by the credentials path.
    expect(config['endpoint']).toBe('https://acc.r2.cloudflarestorage.com')
    expect(config['region']).toBe('auto')
    expect(config['forcePathStyle']).toBe(true)
    // Functional provider, resolving through mapAws (expiration as a Date).
    expect(typeof config['credentials']).toBe('function')
    const resolved = await (config['credentials'] as () => Promise<{ accessKeyId: string; expiration?: Date }>)()
    expect(resolved.accessKeyId).toBe('R2_ROLLING_KEY')
    expect(resolved.expiration).toBeInstanceOf(Date)

    vi.doUnmock('@aws-sdk/client-s3')
  })

  it('builds a function-valued SDK credentials provider from a credentials source', async () => {
    const capturedConfigs: Record<string, unknown>[] = []
    vi.doMock('@aws-sdk/client-s3', () => ({
      S3Client: class {
        constructor(config: Record<string, unknown>) {
          capturedConfigs.push(config)
        }
      },
    }))

    const { toCloudflareR2 } = await import('../src/index.js')
    toCloudflareR2({
      bucket: 'b',
      accountId: 'acc',
      credentials: async () => ROLLING,
    })

    expect(capturedConfigs).toHaveLength(1)
    expect(typeof capturedConfigs[0]['credentials']).toBe('function')

    vi.doUnmock('@aws-sdk/client-s3')
  })

  it('rejects construction with neither credentials nor client', () => {
    expect(() => toCloudflareR2({ bucket: 'b', accountId: 'acc' })).toThrow(
      /`credentials` source or a pre-built `client`/,
    )
  })

  it('pre-built client short-circuits — no S3Client constructed even when credentials is supplied', async () => {
    const capturedConfigs: Record<string, unknown>[] = []
    vi.doMock('@aws-sdk/client-s3', () => ({
      S3Client: class {
        constructor(config: Record<string, unknown>) {
          capturedConfigs.push(config)
        }
      },
    }))

    const { toCloudflareR2 } = await import('../src/index.js')
    const fakeClient = { send: async () => ({}) }
    toCloudflareR2({ bucket: 'b', client: fakeClient as never, credentials: async () => ROLLING })

    expect(capturedConfigs).toHaveLength(0)

    vi.doUnmock('@aws-sdk/client-s3')
  })

  it('still requires accountId when only credentials is supplied (endpoint derivation)', async () => {
    const { toCloudflareR2 } = await import('../src/index.js')
    expect(() => toCloudflareR2({ bucket: 'b', credentials: async () => ROLLING })).toThrow(/client.*accountId/i)
  })
})
