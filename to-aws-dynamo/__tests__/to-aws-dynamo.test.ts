import { describe, it, expect } from 'vitest'
import type { EncryptedEnvelope } from '@noy-db/hub/to'
import { ConflictError } from '@noy-db/hub/to'
import { toAwsDynamo, type DynamoDocClient } from '../src/index.js'

/**
 * In-memory mock DynamoDB document client. Mirrors the single-table
 * `pk = vault`, `sk = {collection}#{id}` layout the store writes.
 */
function mockClient(): { client: DynamoDocClient; items: Map<string, Record<string, unknown>> } {
  const items = new Map<string, Record<string, unknown>>()
  const key = (pk: string, sk: string) => `${pk}\x00${sk}`

  const client: DynamoDocClient = {
    async send(command: unknown) {
      const name = (command as { constructor?: { name?: string } }).constructor?.name ?? 'Unknown'
      const input = (command as { input?: Record<string, unknown> }).input ?? {}

      if (name === 'PutCommand') {
        const item = input['Item'] as Record<string, unknown>
        items.set(key(item['pk'] as string, item['sk'] as string), item)
        return {}
      }
      if (name === 'GetCommand') {
        const k = input['Key'] as { pk: string; sk: string }
        const item = items.get(key(k.pk, k.sk))
        return { Item: item }
      }
      throw new Error(`Mock client got unexpected command: ${name}`)
    },
  }
  return { client, items }
}

describe('@noy-db/to-aws-dynamo — full-envelope round-trip', () => {
  it('round-trips a _del delete-marker envelope byte-identically', async () => {
    const { client } = mockClient()
    const adapter = toAwsDynamo({ table: 't', client })

    const envelope: EncryptedEnvelope = {
      _noydb: 1,
      _v: 2,
      _ts: '2026-07-09T00:00:00.000Z',
      _iv: '',
      _data: '',
      _del: true,
    }
    await adapter.put('v1', 'c1', 'del1', envelope)
    const result = await adapter.get('v1', 'c1', 'del1')
    expect(result).toEqual(envelope)
  })

  it('round-trips a maximal envelope byte-identically (every field survives, not just _del)', async () => {
    const { client } = mockClient()
    const adapter = toAwsDynamo({ table: 't', client })

    const envelope: EncryptedEnvelope = {
      _noydb: 1,
      _v: 3,
      _ts: '2026-07-09T00:00:00.000Z',
      _iv: 'dGVzdC1pdg==',
      _data: 'Y2lwaGVydGV4dA==',
      _by: 'alice',
      _tier: 2,
      _elevatedBy: 'bob',
      _det: { email: 'abc:def' },
      _cek: 'wrapped-cek-b64',
      _debug: 1,
      _del: true,
    }
    await adapter.put('v1', 'c1', 'maximal1', envelope)
    const result = await adapter.get('v1', 'c1', 'maximal1')
    expect(result).toEqual(envelope)
  })

  it('reconstructs a legacy item (_env absent, _iv/_data/_del attributes populated) via dual-read fallback', async () => {
    // Simulates an item written before the `_env` migration — no `_env`
    // attribute, real data in the old per-attribute layout. Seeded directly
    // into the mock's backing store — never went through `adapter.put()`.
    const { client, items } = mockClient()
    const adapter = toAwsDynamo({ table: 't', client })

    items.set('v1\x00c1#legacy1', {
      pk: 'v1',
      sk: 'c1#legacy1',
      _v: 5,
      _ts: '2026-01-01T00:00:00.000Z',
      _iv: 'legacy-iv',
      _data: 'legacy-ciphertext',
      _del: true,
    })

    const result = await adapter.get('v1', 'c1', 'legacy1')
    expect(result).toEqual({
      _noydb: 1,
      _v: 5,
      _ts: '2026-01-01T00:00:00.000Z',
      _iv: 'legacy-iv',
      _data: 'legacy-ciphertext',
      _del: true,
    })
  })

  it('put(..., expectedVersion) throws ConflictError on a ConditionalCheckFailedException', async () => {
    // Mock a conditional PutCommand that always fails its ConditionExpression
    // (simulating a concurrent writer that already bumped `_v`), matching the
    // real DynamoDB error shape the store checks for by `.name`.
    const conflictErr = Object.assign(new Error('ConditionalCheckFailedException'), {
      name: 'ConditionalCheckFailedException',
    })
    const client: DynamoDocClient = {
      async send(command: unknown) {
        const name = (command as { constructor?: { name?: string } }).constructor?.name ?? 'Unknown'
        const input = (command as { input?: Record<string, unknown> }).input ?? {}
        if (name === 'PutCommand') {
          if (input['ConditionExpression']) throw conflictErr
          return {}
        }
        if (name === 'GetCommand') {
          // Current version fetched by the store to build the ConflictError.
          return { Item: { pk: 'v1', sk: 'c1#r1', _v: 4, _ts: 't', _iv: 'iv', _data: 'data' } }
        }
        throw new Error(`Mock client got unexpected command: ${name}`)
      },
    }
    const adapter = toAwsDynamo({ table: 't', client })

    const envelope: EncryptedEnvelope = {
      _noydb: 1, _v: 5, _ts: '2026-07-09T00:00:00.000Z', _iv: 'iv', _data: 'data',
    }
    try {
      await adapter.put('v1', 'c1', 'r1', envelope, 3)
      expect.unreachable('expected put() to throw ConflictError')
    } catch (err) {
      expect(err).toBeInstanceOf(ConflictError)
      expect((err as ConflictError).version).toBe(4)
    }
  })
})
