import type { S3Client } from '@aws-sdk/client-s3'

/**
 * Full in-memory S3 fake for the conformance suite (#26) — models every
 * command the store family emits (`toAwsS3` and, via client injection,
 * `toCloudflareR2`): conditional writes (`IfNoneMatch`/`IfMatch` → 412),
 * `NoSuchKey`/`NotFound` errors, server-assigned `LastModified`, and
 * lexicographically-sorted `ListObjectsV2` with `ContinuationToken`
 * pagination — the property `listPage()` relies on.
 *
 * The narrower CAS-focused fake in `cas.test.ts` (with its concurrent-writer
 * hook) stays separate: it exists to prove the IfMatch guard under injected
 * races, which needs hooks this general-purpose fake doesn't carry.
 */
export function fakeS3(): { client: S3Client; objects: Map<string, { body: string; etag: string; lastModified: Date }> } {
  const objects = new Map<string, { body: string; etag: string; lastModified: Date }>()
  let etagSeq = 0

  const precondition = () => {
    const e = new Error('PreconditionFailed')
    e.name = 'PreconditionFailed'
    ;(e as { $metadata?: unknown }).$metadata = { httpStatusCode: 412 }
    return e
  }
  const notFound = (name: string) => {
    const e = new Error(name)
    e.name = name
    return e
  }

  const client = {
    async send(command: unknown) {
      const name = (command as { constructor: { name: string } }).constructor.name
      const input = (command as { input: Record<string, unknown> }).input

      if (name === 'PutObjectCommand') {
        const key = input.Key as string
        const current = objects.get(key)
        const ifNoneMatch = input.IfNoneMatch as string | undefined
        const ifMatch = input.IfMatch as string | undefined
        if (ifNoneMatch === '*' && current) throw precondition()
        if (ifMatch !== undefined && (!current || `"${current.etag}"` !== ifMatch)) throw precondition()
        const etag = `e${++etagSeq}`
        objects.set(key, { body: input.Body as string, etag, lastModified: new Date() })
        return { ETag: `"${etag}"` }
      }
      if (name === 'GetObjectCommand') {
        const obj = objects.get(input.Key as string)
        if (!obj) throw notFound('NoSuchKey')
        return {
          ETag: `"${obj.etag}"`,
          LastModified: obj.lastModified,
          Body: { async transformToString() { return obj.body } },
        }
      }
      if (name === 'HeadObjectCommand') {
        const obj = objects.get(input.Key as string)
        if (!obj) throw notFound('NotFound')
        return { ETag: `"${obj.etag}"`, LastModified: obj.lastModified }
      }
      if (name === 'DeleteObjectCommand') {
        objects.delete(input.Key as string)
        return {}
      }
      if (name === 'ListObjectsV2Command') {
        const prefix = (input.Prefix as string | undefined) ?? ''
        const maxKeys = (input.MaxKeys as number | undefined) ?? 1000
        const after = (input.ContinuationToken as string | undefined) ?? ''
        const matched = [...objects.entries()]
          .filter(([k]) => k.startsWith(prefix) && k > after)
          .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        const page = matched.slice(0, maxKeys)
        const truncated = matched.length > maxKeys
        return {
          Contents: page.map(([k, o]) => ({ Key: k, LastModified: o.lastModified })),
          IsTruncated: truncated,
          ...(truncated ? { NextContinuationToken: page[page.length - 1]![0] } : {}),
        }
      }
      if (name === 'HeadBucketCommand') return {}
      throw new Error(`fake S3: unexpected command ${name}`)
    },
  } as unknown as S3Client

  return { client, objects }
}
