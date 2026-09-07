import { describe, expect, it } from 'vitest'
import type { LibsqlClient } from '../src/index.js'
import { toTurso } from '../src/index.js'

// noy-db-to#22 — toTurso() implements `tx()` but never declared `txAtomic`,
// so consumers gating on `capabilities.txAtomic === true` never routed to the
// implementation (dead code). libSQL's `batch()` executes its statements in
// one implicit transaction (all-or-nothing), so the capability is honest
// exactly when the client exposes `batch`:
//   - injected client WITH batch  → txAtomic: true
//   - injected client WITHOUT batch → txAtomic: false (sequential fallback
//     is not atomic and must not be advertised)
//   - clientFactory path → true (factory-built clients are real
//     @libsql/client instances, which always expose batch)

function batchClient(): LibsqlClient & { batches: number; statementCounts: number[] } {
  const state = { batches: 0, statementCounts: [] as number[] }
  return {
    get batches() { return state.batches },
    get statementCounts() { return state.statementCounts },
    async execute() { return { rows: [] } },
    async batch(statements: readonly { sql: string }[]) {
      state.batches++
      state.statementCounts.push(statements.length)
      return statements.map(() => ({ rows: [] }))
    },
  }
}

describe('to-turso — txAtomic capability (#22)', () => {
  it('declares txAtomic: true when the injected client supports batch', () => {
    const store = toTurso({ client: batchClient() })
    expect(store.capabilities.txAtomic).toBe(true)
  })

  it('declares txAtomic: false when the injected client lacks batch', () => {
    const store = toTurso({ client: { execute: async () => ({ rows: [] }) } })
    expect(store.capabilities.txAtomic).toBe(false)
  })

  it('declares txAtomic: true on the clientFactory path', () => {
    const store = toTurso({
      clientFactory: () => batchClient(),
      credentials: async () => ({ kind: 'token', token: 't' }),
    })
    expect(store.capabilities.txAtomic).toBe(true)
  })

  it('tx() sends all ops as one batch (single implicit transaction)', async () => {
    const client = batchClient()
    const store = toTurso({ client })
    const envelope = { _noydb: 1 as const, _v: 1, _ts: 't', _iv: 'i', _data: 'd' }

    await store.tx!([
      { type: 'put', vault: 'v', collection: 'c', id: 'a', envelope },
      { type: 'put', vault: 'v', collection: 'c', id: 'b', envelope },
      { type: 'delete', vault: 'v', collection: 'c', id: 'z' },
    ])

    expect(client.batches).toBe(1)
    expect(client.statementCounts).toEqual([3])
  })
})
