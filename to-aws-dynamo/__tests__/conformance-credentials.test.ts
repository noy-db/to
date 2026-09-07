/**
 * Store-contract conformance in the **injected-credentials** configuration
 * (#17) — the browser/LIFF client shape, driven by short-lived credentials
 * that expire and are re-fetched rather than by an ambient credential chain.
 *
 * `conformance.test.ts` builds the store over `_fake-dynamo.ts`, a duck-typed
 * `{ send }` object. A store given a `client` never builds one, so
 * `options.credentials` is never consulted and that run is blind to the
 * credential path — and, because it intercepts at the command layer, it also
 * skips the `DynamoDBDocumentClient` marshalling round-trip entirely.
 *
 * Here a REAL client stack is constructed with a real credentials provider,
 * so the SDK's genuine SigV4 signer consumes credentials on every request and
 * the marshalling actually runs.
 */
import { describe, expect, it } from 'vitest'
import { DynamoDBClient } from '@aws-sdk/client-dynamodb'
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb'
import { runStoreConformanceTests } from '@noy-db/test-adapter-conformance'
import { toAwsDynamo } from '../src/index.js'
import { signedDynamoFake } from './_signed-dynamo.js'

const TABLE = 'conformance'

function credentialDrivenStore() {
  const fake = signedDynamoFake()
  let issued = 0
  const ddb = new DynamoDBClient({
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
  const client = DynamoDBDocumentClient.from(ddb)
  return { store: toAwsDynamo({ table: TABLE, client }), fake, issued: () => issued }
}

runStoreConformanceTests(
  'to-aws-dynamo (real SigV4 signing over injected temporary credentials)',
  async () => credentialDrivenStore().store,
)

describe('to-aws-dynamo — the credentials configuration is real, not nominal (#17)', () => {
  it('signs every request with the injected credentials, and re-resolves them as they expire', async () => {
    const { store, fake, issued } = credentialDrivenStore()

    const env = { _noydb: 1 as const, _v: 1, _ts: new Date().toISOString(), _iv: 'i', _data: 'ZA==' }
    await store.put('v', 'c', 'a', env)
    await store.get('v', 'c', 'a')
    await store.list('v', 'c')

    expect(fake.authorizations.length).toBeGreaterThan(0)
    for (const auth of fake.authorizations) expect(auth).toMatch(/^AWS4-HMAC-SHA256 /)

    // Signed with the credentials WE injected, not an ambient chain.
    expect(fake.authorizations.every(a => /Credential=ASIA-ROTATING-\d+\//.test(a))).toBe(true)

    // Re-resolved rather than cached once — the property a browser client
    // with expiring STS credentials depends on.
    expect(issued()).toBeGreaterThan(1)
  })

  /**
   * Pins one semantic of the TRANSPORT FAKE that the conformance suite does
   * NOT reach, established by mutation rather than assumed: letting
   * `#v = :expected` pass on a missing item leaves the whole conformance run
   * green. A fake nothing tests drifts from the real service silently, and
   * every suite built on it inherits the drift while staying green.
   *
   * The fake's transaction ATOMICITY deliberately has no test here — the kit
   * already covers it. Making the fake apply writes as it goes fails its two
   * `#920` tests ("enforces expectedVersion atomically" and "rolls back every
   * op when one leg fails"), so a local copy would be redundant coverage
   * dressed as extra safety.
   */
  it('fails a non-zero expectedVersion against a missing item (`#v = :expected` has no OR clause)', async () => {
    const { store } = credentialDrivenStore()
    const env = { _noydb: 1 as const, _v: 5, _ts: new Date().toISOString(), _iv: 'i', _data: 'ZA==' }

    // expectedVersion 5 on an id that does not exist: the condition must NOT
    // hold. Treating a missing item as passing is the classic CAS hole — a
    // write that believes it is updating v5 silently creating a fresh record.
    await expect(store.tx!([
      { type: 'put', vault: 'v', collection: 'c', id: 'absent', envelope: env, expectedVersion: 5 },
    ])).rejects.toThrow()
    expect(await store.get('v', 'c', 'absent')).toBeNull()
  })

  it('surfaces a credentials-provider failure instead of silently falling back', async () => {
    const fake = signedDynamoFake()
    const ddb = new DynamoDBClient({
      region: 'us-east-1',
      credentials: async () => { throw new Error('STS vend failed') },
      requestHandler: fake.requestHandler,
    })
    const store = toAwsDynamo({ table: TABLE, client: DynamoDBDocumentClient.from(ddb) })

    await expect(store.get('v', 'c', 'a')).rejects.toThrow(/STS vend failed/)
    // Nothing was signed or sent. A fallback to an ambient chain would have
    // produced a request here — the failure that works on a laptop and fails
    // in a browser.
    expect(fake.authorizations).toEqual([])
  })
})
