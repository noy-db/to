import { describe, it, expect } from 'vitest'
import type { EncryptedEnvelope } from '@noy-db/hub/to'
import { fakeDynamo } from './_fake-dynamo.js'
import { toAwsDynamo } from '../src/index.js'

/**
 * #17 — the key layout is a DEPLOYMENT CONTRACT, not an implementation
 * detail. A direct-to-cloud client is confined to its own vault by an IAM
 * `dynamodb:LeadingKeys` condition, and that condition is written against
 * exactly the `pk` produced here. If the layout moves, every deployed
 * policy silently stops matching — so the README documents it and this
 * file is what keeps the README honest.
 *
 * These assertions exist to FAIL if the layout changes. Changing them to
 * match new behaviour is a breaking change to every deployed IAM policy.
 */

const envelope: EncryptedEnvelope = {
  _noydb: 1,
  _v: 1,
  _ts: '2026-08-21T00:00:00.000Z',
  _iv: '',
  _data: '',
}

describe('to-aws-dynamo — published key layout (#17)', () => {
  it('writes pk = vault and sk = `{collection}#{id}`', async () => {
    const { client, items } = fakeDynamo()
    const store = toAwsDynamo({ table: 't', client })

    await store.put('alice', 'docs', 'd1', envelope)

    const item = [...items.values()][0]!
    expect(item['pk']).toBe('alice')
    expect(item['sk']).toBe('docs#d1')
  })

  it('keeps the vault WHOLLY in pk, so a LeadingKeys condition can confine a client', async () => {
    const { client, items } = fakeDynamo()
    const store = toAwsDynamo({ table: 't', client })

    await store.put('alice', 'docs', 'd1', envelope)
    await store.put('alice', 'notes', 'n1', envelope)
    await store.put('bob', 'docs', 'd1', envelope)

    const pks = new Set([...items.values()].map((i) => i['pk']))
    expect(pks).toEqual(new Set(['alice', 'bob']))
  })

  it('tolerates `#` inside an id — the sk splits on the FIRST separator only', async () => {
    const { client } = fakeDynamo()
    const store = toAwsDynamo({ table: 't', client })

    await store.put('alice', 'docs', 'has#hash', envelope)
    expect(await store.get('alice', 'docs', 'has#hash')).toEqual(envelope)
  })

  it('ping() queries the RESERVED `__ping__` partition, not DescribeTable', async () => {
    // Load-bearing for #17: a client scoped by
    // `dynamodb:LeadingKeys: ["alice"]` cannot read pk `__ping__`, so ping()
    // returns FALSE against a perfectly healthy table. The README documents
    // this; granting `dynamodb:DescribeTable` does not fix it, because that
    // is not the call being made.
    const seen: unknown[] = []
    const client = {
      async send(command: unknown) {
        seen.push((command as { input?: unknown }).input)
        return { Items: [] }
      },
    }
    const store = toAwsDynamo({ table: 't', client: client as never })

    expect(await store.ping!()).toBe(true)
    expect(seen).toHaveLength(1)
    expect(seen[0]).toMatchObject({
      TableName: 't',
      KeyConditionExpression: 'pk = :pk',
      ExpressionAttributeValues: { ':pk': '__ping__' },
    })
  })
})
