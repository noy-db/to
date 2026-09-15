# @noy-db/to-rest

REST/HTTP adapter for [noy-db](https://github.com/noy-db/core) — a `NoydbStore` client for the
`@noy-db/in-rest` **ciphertext RPC proxy**. The HTTP mirror of `@noy-db/by-peer`'s `peerStore()`.

## What it is

Every store method is serialized as `POST {baseUrl}/rpc` with `{ method, args }` — the positional
args tuple, exactly as the `NoydbStore` signature. On the other end, an `@noy-db/in-rest`
`createRestHandler` funnels the RPC into its own backing store. The server forwards encrypted
envelopes verbatim: it never sees a secret or plaintext.

```ts
// Server (anywhere you can run a request handler):
import { createRestHandler } from '@noy-db/in-rest'
const handler = createRestHandler({
  store: backingStore, // any NoydbStore — file, postgres, s3, …
  authorize: (req) => req.headers['authorization'] === `Bearer ${API_KEY}`,
})

// Client:
import { toRest } from '@noy-db/to-rest'
const store = toRest({
  baseUrl: 'https://vault.example.com/api',
  headers: { authorization: `Bearer ${API_KEY}` },
})
const db = await createNoydb({ store })
```

## Authentication

The in-rest server is **fail-closed**: with no `authorize` hook it rejects every request. Send
whatever the server's hook expects — typically an `Authorization` header — via `headers`.

## Error mapping

| Server response | Client behavior |
|---|---|
| `200` | result returned as-is |
| `409 { error: { name: 'ConflictError', version? } }` | re-thrown as `ConflictError` — CAS survives the wire hop. Keyed on `name` alone; `version` is OPTIONAL and becomes `NaN` when the server omits it |
| `401` | auth error (check the `Authorization` header) |
| `403` | method not in the server's `allow` set |
| `501` | the server's backing store lacks this optional method |
| other | server error carrying the error name only (the server never echoes internals) |

## Status

**Pre-release**. Requires an `@noy-db/in-rest` server ≥ `0.6.0-pre.0` (the RPC-proxy architecture).

## Documentation

See the [main repository](https://github.com/noy-db/core#readme) for setup, examples, and the full subsystem catalog.

- Source — [`to-rest`](https://github.com/noy-db/to/tree/main/to-rest)
- Issues — [github.com/noy-db/to/issues](https://github.com/noy-db/to/issues)

## License

[Apache-2.0](./LICENSE) © vLannaAi
