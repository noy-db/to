import type { HttpRequest } from '@smithy/protocol-http'
import { Readable } from 'node:stream'

/**
 * Transport-level DynamoDB fake for the **injected-credentials** conformance
 * run (#17). Counterpart to `to-aws-s3/__tests__/_signed-s3.ts`; see that
 * file for why a second fake exists at all.
 *
 * Short version: `_fake-dynamo.ts` is a duck-typed `{ send }` object at the
 * *command* layer, so a store built with it never constructs a client and
 * `options.credentials` is inert. This one sits at the `requestHandler`
 * layer, under a REAL `DynamoDBClient`, so the SDK's genuine SigV4 signer
 * consumes credentials on every request and — unlike the command-layer fake —
 * the `DynamoDBDocumentClient` marshalling round-trip actually runs.
 *
 * Speaks AWS JSON 1.0: operation in `X-Amz-Target`, marshalled
 * `AttributeValue` bodies. Models only what the store emits — PutItem
 * (with the `#v = :expected OR attribute_not_exists(pk)` CAS condition),
 * GetItem, DeleteItem, Query (the two `KeyConditionExpression` shapes the
 * store uses, plus `Limit`/`ExclusiveStartKey` pagination) and
 * TransactWriteItems. Anything else answers loudly rather than 200.
 */

type Attr = Record<string, unknown>

/** Minimal marshaller — the store stores strings, numbers and flat maps. */
function marshall(value: unknown): Attr {
  if (value === null) return { NULL: true }
  if (typeof value === 'string') return { S: value }
  if (typeof value === 'number') return { N: String(value) }
  if (typeof value === 'boolean') return { BOOL: value }
  if (Array.isArray(value)) return { L: value.map(marshall) }
  if (typeof value === 'object') {
    const m: Record<string, Attr> = {}
    for (const [k, v] of Object.entries(value as object)) m[k] = marshall(v)
    return { M: m }
  }
  throw new Error(`_signed-dynamo: cannot marshall ${typeof value}`)
}

function unmarshall(attr: Attr): unknown {
  if ('S' in attr) return attr['S']
  if ('N' in attr) return Number(attr['N'])
  if ('BOOL' in attr) return attr['BOOL']
  if ('NULL' in attr) return null
  if ('L' in attr) return (attr['L'] as Attr[]).map(unmarshall)
  if ('M' in attr) {
    const o: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(attr['M'] as Record<string, Attr>)) o[k] = unmarshall(v)
    return o
  }
  throw new Error(`_signed-dynamo: cannot unmarshall ${JSON.stringify(attr)}`)
}

const marshallItem = (item: Record<string, unknown>): Record<string, Attr> => {
  const out: Record<string, Attr> = {}
  for (const [k, v] of Object.entries(item)) out[k] = marshall(v)
  return out
}
const unmarshallItem = (item: Record<string, Attr>): Record<string, unknown> => {
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(item)) out[k] = unmarshall(v)
  return out
}

export interface SignedDynamoFake {
  requestHandler: { handle(request: HttpRequest): Promise<{ response: unknown }> }
  items: Map<string, Record<string, unknown>>
  /** Every `Authorization` header seen — proof the signer actually ran. */
  authorizations: string[]
}

export function signedDynamoFake(): SignedDynamoFake {
  const items = new Map<string, Record<string, unknown>>()
  const authorizations: string[] = []
  const rowKey = (pk: string, sk: string) => `${pk}\x00${sk}`

  const json = (statusCode: number, payload: unknown) => ({
    response: {
      statusCode,
      headers: { 'content-type': 'application/x-amz-json-1.0' },
      body: Readable.from([JSON.stringify(payload)]),
    },
  })
  const failure = (type: string, message: string) =>
    json(400, { __type: `com.amazonaws.dynamodb.v20120810#${type}`, message })

  /**
   * The store issues exactly three CAS conditions, and they mean different
   * things about a MISSING item — which is the whole point of modelling them
   * separately rather than parsing expressions generally:
   *
   * | expression                                  | missing item |
   * |---------------------------------------------|--------------|
   * | `#v = :expected OR attribute_not_exists(pk)`| passes       |
   * | `#v = :expected`                            | FAILS        |
   * | `attribute_not_exists(pk)`                  | passes       |
   *
   * Anything else throws. An unrecognised condition must never silently
   * pass: a store change would then go green against a fake that never
   * evaluated it — and this guard has already earned its place by catching
   * `tx()`'s second shape on the first run.
   */
  function conditionHolds(
    existing: Record<string, unknown> | undefined,
    expression: string | undefined,
    names: Record<string, string> | undefined,
    values: Record<string, Attr> | undefined,
  ): boolean {
    if (!expression) return true

    if (expression === 'attribute_not_exists(pk)') return existing === undefined

    const versionMatches = (): boolean => {
      if (!existing) return false
      const attr = names?.['#v'] ?? '_v'
      const expected = values?.[':expected'] ? unmarshall(values[':expected']!) : undefined
      return existing[attr] === expected
    }

    if (expression === '#v = :expected OR attribute_not_exists(pk)') {
      return existing === undefined || versionMatches()
    }
    if (expression === '#v = :expected') return versionMatches()

    throw new Error(`_signed-dynamo: unmodelled ConditionExpression ${JSON.stringify(expression)}`)
  }

  function query(input: Record<string, unknown>) {
    const expr = input['KeyConditionExpression'] as string
    const values = (input['ExpressionAttributeValues'] ?? {}) as Record<string, Attr>
    const pk = unmarshall(values[':pk']!) as string

    let matched = [...items.entries()]
      .filter(([k]) => k.startsWith(`${pk}\x00`))
      .map(([, v]) => v)

    if (expr === 'pk = :pk AND begins_with(sk, :prefix)') {
      const prefix = unmarshall(values[':prefix']!) as string
      matched = matched.filter(it => String(it['sk']).startsWith(prefix))
    } else if (expr !== 'pk = :pk') {
      throw new Error(`_signed-dynamo: unmodelled KeyConditionExpression ${JSON.stringify(expr)}`)
    }

    // DynamoDB returns items sorted by sort key within a partition.
    matched.sort((a, b) => String(a['sk']).localeCompare(String(b['sk'])))

    const start = input['ExclusiveStartKey'] as Record<string, Attr> | undefined
    if (start) {
      const afterSk = unmarshall(start['sk']!) as string
      matched = matched.filter(it => String(it['sk']) > afterSk)
    }

    const limit = input['Limit'] as number | undefined
    const page = limit === undefined ? matched : matched.slice(0, limit)
    const truncated = limit !== undefined && matched.length > limit

    return json(200, {
      Items: page.map(marshallItem),
      Count: page.length,
      ...(truncated
        ? { LastEvaluatedKey: marshallItem({ pk, sk: page[page.length - 1]!['sk'] }) }
        : {}),
    })
  }

  async function handle(request: HttpRequest): Promise<{ response: unknown }> {
    authorizations.push(String(request.headers['authorization'] ?? ''))

    const target = String(request.headers['x-amz-target'] ?? '')
    const op = target.split('.').pop() ?? ''
    const input = JSON.parse(String(request.body ?? '{}')) as Record<string, unknown>

    if (op === 'PutItem') {
      const item = unmarshallItem(input['Item'] as Record<string, Attr>)
      const k = rowKey(String(item['pk']), String(item['sk']))
      const ok = conditionHolds(
        items.get(k),
        input['ConditionExpression'] as string | undefined,
        input['ExpressionAttributeNames'] as Record<string, string> | undefined,
        input['ExpressionAttributeValues'] as Record<string, Attr> | undefined,
      )
      if (!ok) return failure('ConditionalCheckFailedException', 'The conditional request failed')
      items.set(k, item)
      return json(200, {})
    }

    if (op === 'GetItem') {
      const key = unmarshallItem(input['Key'] as Record<string, Attr>)
      const found = items.get(rowKey(String(key['pk']), String(key['sk'])))
      return json(200, found ? { Item: marshallItem(found) } : {})
    }

    if (op === 'DeleteItem') {
      const key = unmarshallItem(input['Key'] as Record<string, Attr>)
      items.delete(rowKey(String(key['pk']), String(key['sk'])))
      return json(200, {})
    }

    if (op === 'Query') return query(input)

    if (op === 'TransactWriteItems') {
      const ops = (input['TransactItems'] ?? []) as Record<string, Record<string, unknown>>[]
      // All-or-nothing: evaluate every condition BEFORE applying any write,
      // otherwise a late failure leaves earlier writes committed and the
      // fake would quietly report atomicity the real service provides.
      const staged: [string, Record<string, unknown>][] = []
      const deletes: string[] = []
      // ⚠️ Per-item outcomes, positionally aligned with TransactItems. The
      // real service returns these on cancellation and the store NEEDS them:
      // it locates the conflicting op by finding the `ConditionalCheckFailed`
      // entry, and without the array it cannot map the failure to a
      // ConflictError at all — it rethrows the raw SDK exception. Omitting
      // this was under-modelling, and the conformance suite caught it.
      const reasons: { Code: string; Message?: string }[] = ops.map(() => ({ Code: 'None' }))
      let cancelled = false

      for (const [i, entry] of ops.entries()) {
        if (entry['Put']) {
          const put = entry['Put']
          const item = unmarshallItem(put['Item'] as Record<string, Attr>)
          const k = rowKey(String(item['pk']), String(item['sk']))
          const ok = conditionHolds(
            items.get(k),
            put['ConditionExpression'] as string | undefined,
            put['ExpressionAttributeNames'] as Record<string, string> | undefined,
            put['ExpressionAttributeValues'] as Record<string, Attr> | undefined,
          )
          if (!ok) {
            reasons[i] = { Code: 'ConditionalCheckFailed', Message: 'The conditional request failed' }
            cancelled = true
            continue
          }
          staged.push([k, item])
        } else if (entry['Delete']) {
          const key = unmarshallItem(entry['Delete']['Key'] as Record<string, Attr>)
          deletes.push(rowKey(String(key['pk']), String(key['sk'])))
        } else {
          throw new Error(`_signed-dynamo: unmodelled transact entry ${Object.keys(entry).join(',')}`)
        }
      }

      if (cancelled) {
        return json(400, {
          __type: 'com.amazonaws.dynamodb.v20120810#TransactionCanceledException',
          message: 'Transaction cancelled, please refer cancellation reasons for specific reasons',
          CancellationReasons: reasons,
        })
      }

      // Applied only after every condition held — nothing is written on a
      // cancelled transaction. Load-bearing and covered: making this write as
      // it goes fails the kit's two #920 atomicity tests (verified by
      // mutation), so the property is asserted by a different author.
      for (const [k, item] of staged) items.set(k, item)
      for (const k of deletes) items.delete(k)
      return json(200, {})
    }

    throw new Error(`_signed-dynamo: unmodelled operation ${JSON.stringify(target)}`)
  }

  return { requestHandler: { handle }, items, authorizations }
}
