import type { HttpRequest } from '@smithy/protocol-http'
import { Readable } from 'node:stream'

/**
 * Transport-level S3 fake for the **injected-credentials** conformance run
 * (#17), and the reason it exists rather than reusing `_fake-s3.ts`.
 *
 * `_fake-s3.ts` is a duck-typed `{ send }` object cast to `S3Client`. It
 * models the SDK's *command* layer, which means a store built with it never
 * constructs a client of its own — so `options.credentials` is inert and the
 * conformance run proves nothing about the credential path. That is the whole
 * gap #17's last task names: the existing suite is green and blind to it.
 *
 * This fake sits one layer lower, as a `requestHandler`. A **real**
 * `S3Client` is constructed with a real credentials provider, so the SDK's
 * genuine SigV4 signer runs and *consumes* the credentials before anything
 * reaches here — the request arrives already signed. No network is involved.
 *
 * ⚠️ It therefore tests a DIFFERENT property from `credentials.test.ts`, and
 * both are needed. That file asserts, structurally, that `toAwsS3()` threads
 * `options.credentials` into the config of the client it builds. This one
 * asserts, behaviourally, that the full store contract holds while
 * credentials are being resolved and re-resolved. Neither implies the other.
 *
 * Models only what the store emits: PutObject (with `IfNoneMatch`/`IfMatch`
 * preconditions → 412), GetObject, HeadObject, HeadBucket, DeleteObject, and
 * ListObjectsV2 with lexicographic ordering, `MaxKeys` and continuation
 * tokens. Anything else answers 501 loudly rather than silently succeeding.
 */

interface StoredObject {
  body: string
  etag: string
  lastModified: Date
}

const xmlEscape = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

const errorBody = (code: string): Readable =>
  Readable.from([`<?xml version="1.0" encoding="UTF-8"?><Error><Code>${code}</Code><Message>${code}</Message></Error>`])

export interface SignedS3Fake {
  /** Passed to a real `S3Client` as `requestHandler`. */
  requestHandler: { handle(request: HttpRequest): Promise<{ response: unknown }> }
  objects: Map<string, StoredObject>
  /** Every `Authorization` header seen — proof the signer actually ran. */
  authorizations: string[]
}

export function signedS3Fake(bucket: string): SignedS3Fake {
  const objects = new Map<string, StoredObject>()
  const authorizations: string[] = []
  let etagSeq = 0

  const reply = (statusCode: number, headers: Record<string, string> = {}, body?: Readable) => ({
    response: { statusCode, headers, body },
  })

  async function handle(request: HttpRequest): Promise<{ response: unknown }> {
    authorizations.push(String(request.headers['authorization'] ?? ''))

    const query = (request.query ?? {}) as Record<string, string | undefined>

    // ⚠️ Both addressing styles must be handled, and getting this wrong is
    // silent. The SDK uses VIRTUAL-HOSTED style when the bucket name is
    // DNS-compatible (`conformance` is), putting the bucket in the hostname
    // and leaving the path as `/<key…>`. It falls back to PATH style
    // (`/<bucket>/<key…>`) otherwise. Stripping a leading segment
    // unconditionally silently eats the first key component — which reads as
    // "listing returns nothing" rather than as an error.
    const rawPath = request.path.startsWith(`/${bucket}/`)
      ? request.path.slice(bucket.length + 1)
      : request.path.startsWith(`/${bucket}`) && request.path.length === bucket.length + 1
        ? '/'
        : request.path
    const key = decodeURIComponent(rawPath.replace(/^\//, ''))

    // ListObjectsV2 is a GET on the bucket itself with `list-type=2`.
    if (request.method === 'GET' && query['list-type'] === '2') {
      return listObjects(query)
    }

    if (request.method === 'HEAD' && key === '') return reply(200) // HeadBucket

    if (request.method === 'PUT') {
      const existing = objects.get(key)
      const ifNoneMatch = request.headers['if-none-match']
      const ifMatch = request.headers['if-match']
      // `IfNoneMatch: *` means "create only"; IfMatch pins a known ETag.
      if (ifNoneMatch === '*' && existing) return reply(412, {}, errorBody('PreconditionFailed'))
      if (ifMatch !== undefined && (!existing || existing.etag !== ifMatch)) {
        return reply(412, {}, errorBody('PreconditionFailed'))
      }
      const etag = `"etag-${++etagSeq}"`
      objects.set(key, { body: String(request.body ?? ''), etag, lastModified: new Date() })
      return reply(200, { etag })
    }

    if (request.method === 'GET') {
      const obj = objects.get(key)
      if (!obj) return reply(404, {}, errorBody('NoSuchKey'))
      return reply(
        200,
        { etag: obj.etag, 'last-modified': obj.lastModified.toUTCString(), 'content-length': String(obj.body.length) },
        Readable.from([obj.body]),
      )
    }

    if (request.method === 'HEAD') {
      const obj = objects.get(key)
      if (!obj) return reply(404, {}, errorBody('NotFound'))
      return reply(200, { etag: obj.etag, 'last-modified': obj.lastModified.toUTCString() })
    }

    if (request.method === 'DELETE') {
      objects.delete(key)
      return reply(204)
    }

    // Never answer 200 to something unmodelled: a silent success here would
    // let a store change go green against a fake that does not implement it.
    return reply(501, {}, errorBody('NotImplemented'))
  }

  function listObjects(query: Record<string, string | undefined>) {
    const prefix = query['prefix'] ? decodeURIComponent(query['prefix']) : ''
    const maxKeys = query['max-keys'] ? Number(query['max-keys']) : 1000
    const token = query['continuation-token'] ? decodeURIComponent(query['continuation-token']) : undefined

    // S3 returns keys in lexicographic order; the continuation token is
    // opaque, so the fake uses "the key to resume strictly after".
    const all = [...objects.keys()].filter(k => k.startsWith(prefix)).sort()
    const start = token ? all.findIndex(k => k > token) : 0
    const from = start === -1 ? all.length : start
    const page = all.slice(from, from + maxKeys)
    const truncated = from + maxKeys < all.length
    const next = truncated ? page[page.length - 1] : undefined

    const contents = page
      .map((k) => {
        const o = objects.get(k)!
        return `<Contents><Key>${xmlEscape(k)}</Key><LastModified>${o.lastModified.toISOString()}</LastModified>`
          + `<ETag>${xmlEscape(o.etag)}</ETag><Size>${o.body.length}</Size></Contents>`
      })
      .join('')

    const xml = '<?xml version="1.0" encoding="UTF-8"?>'
      + '<ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/">'
      + `<Name>${xmlEscape(bucket)}</Name><Prefix>${xmlEscape(prefix)}</Prefix>`
      + `<KeyCount>${page.length}</KeyCount><MaxKeys>${maxKeys}</MaxKeys>`
      + `<IsTruncated>${truncated}</IsTruncated>`
      + (next ? `<NextContinuationToken>${xmlEscape(next)}</NextContinuationToken>` : '')
      + contents
      + '</ListBucketResult>'

    return reply(200, { 'content-type': 'application/xml' }, Readable.from([xml]))
  }

  return { requestHandler: { handle }, objects, authorizations }
}
