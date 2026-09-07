/**
 * Store-contract conformance in the **injected-credentials** configuration
 * (#17) — the browser/LIFF client shape, where the store is driven by
 * short-lived credentials that expire and are re-fetched rather than by an
 * ambient credential chain.
 *
 * Why this is a second conformance run rather than an extra credentials test:
 * `conformance.test.ts` builds the store over `_fake-s3.ts`, a duck-typed
 * `{ send }` object. A store given a `client` never builds one, so
 * `options.credentials` is never consulted and that whole run is blind to the
 * credential path. Here a REAL `S3Client` is constructed with a real
 * credentials provider, so the SDK's genuine SigV4 signer resolves and
 * consumes credentials on every request before the transport fake sees it.
 *
 * The conformance suite is the value: it is written by a different author, so
 * it exercises orderings and edge cases these packages' own tests never
 * pictured — which is exactly what a hand-written credentials test cannot do
 * for itself.
 */
import { describe, expect, it } from 'vitest'
import { S3Client } from '@aws-sdk/client-s3'
import { runStoreConformanceTests } from '@noy-db/test-adapter-conformance'
import { toAwsS3 } from '../src/index.js'
import { signedS3Fake } from './_signed-s3.js'

const BUCKET = 'conformance'

/**
 * A store whose client is credential-driven: every request is signed with
 * credentials obtained from `provider`, which the SDK re-invokes as they near
 * expiry. `expiration` is deliberately short so the suite crosses at least
 * one refresh boundary rather than signing everything with one key.
 */
function credentialDrivenStore() {
  const fake = signedS3Fake(BUCKET)
  let issued = 0
  const client = new S3Client({
    region: 'us-east-1',
    credentials: async () => {
      issued += 1
      return {
        accessKeyId: `ASIA-ROTATING-${issued}`,
        secretAccessKey: 'secret',
        sessionToken: `session-${issued}`,
        // Already-elapsed expiry: the SDK's memoizer must re-resolve rather
        // than cache one key for the whole suite.
        expiration: new Date(Date.now() - 1_000),
      }
    },
    requestHandler: fake.requestHandler,
  })
  return { store: toAwsS3({ bucket: BUCKET, client }), fake, issued: () => issued }
}

runStoreConformanceTests(
  'to-aws-s3 (real SigV4 signing over injected temporary credentials)',
  async () => credentialDrivenStore().store,
)

describe('to-aws-s3 — the credentials configuration is real, not nominal (#17)', () => {
  it('signs every request with the injected credentials, and re-resolves them as they expire', async () => {
    const { store, fake, issued } = credentialDrivenStore()

    const env = { _noydb: 1 as const, _v: 1, _ts: new Date().toISOString(), _iv: 'i', _data: 'ZA==' }
    await store.put('v', 'c', 'a', env)
    await store.get('v', 'c', 'a')
    await store.list('v', 'c')

    // Every request carried a SigV4 signature...
    expect(fake.authorizations.length).toBeGreaterThan(0)
    for (const auth of fake.authorizations) expect(auth).toMatch(/^AWS4-HMAC-SHA256 /)

    // ...computed from the credentials WE injected, not an ambient chain.
    expect(fake.authorizations.every(a => /Credential=ASIA-ROTATING-\d+\//.test(a))).toBe(true)

    // ...and the provider was re-invoked rather than resolved once, which is
    // the property a browser client with expiring STS credentials depends on.
    expect(issued()).toBeGreaterThan(1)
  })

  it('surfaces a credentials-provider failure instead of silently falling back', async () => {
    const fake = signedS3Fake(BUCKET)
    const client = new S3Client({
      region: 'us-east-1',
      credentials: async () => { throw new Error('STS vend failed') },
      requestHandler: fake.requestHandler,
    })
    const store = toAwsS3({ bucket: BUCKET, client })

    await expect(store.get('v', 'c', 'a')).rejects.toThrow(/STS vend failed/)
    // Nothing was signed or sent — a fallback to an ambient chain would have
    // produced a request here, and that is the failure worth catching: it
    // would work on a developer laptop and fail in a browser.
    expect(fake.authorizations).toEqual([])
  })
})
