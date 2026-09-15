# noy-db-to

Extended storage adapters for [noy-db](https://github.com/noy-db/core) — the non-essential
`to-*` family (cloud, server, remote filesystem). Each adapter is a thin, zero-knowledge
`NoydbStore` implementation bound to the published `@noy-db/hub/to` contract; the hub encrypts
before any adapter is called, so stores only ever see ciphertext.

The essential default stores (`to-memory`, `to-file`, `to-browser-idb`, `to-meter`) ship from
the `noy-db` core repo. Install only the adapter you need, e.g. `pnpm add @noy-db/to-aws-s3 @noy-db/hub`.

## What a passing test suite here does and does not prove

Every gate in this repo — build, typecheck, lint, the full suite, and the published
`@noy-db/test-adapter-conformance` kit — exercises the **store contract**: the six methods
moving opaque envelopes in and out. None of them decrypts anything. The conformance kit builds
its envelopes in-process with placeholder `_iv` / `_data` values and performs no AEAD, which is
also why it is *not* version-locked to any particular hub.

So when `@noy-db/hub` changes its **encryption format** — the AAD tuple, the record-identity
binding, which envelope fields are authenticated — a green run here is not evidence that the
change is compatible.

**The architecture is the evidence, not the suite.** The hub encrypts before any store is
called and decrypts after any store returns, so a format change is invisible across this seam
by construction. That is a stronger claim than a passing test, because it holds for changes
nobody has written a test for.

It cuts both ways, and the second half is the one worth remembering:

- A store cannot *break* on a format change — it never interprets what it holds.
- A store will also faithfully return data that **no current hub can open**, and nothing at
  this layer will notice. That is a hub question surfacing in a store-shaped place.

The practical rule this yields:

> The only store code a format change can affect is code that **synthesizes** an envelope
> rather than passing one through.

If an adapter ever reconstructs an envelope from parts — a legacy column layout, a migration
fallback — that reconstruction *is* an input to the hub's authentication. Silently dropping a
field it does not know about surfaces much later as a decryption failure that points at the
wrong component. Pass envelopes through whole; if you must rebuild one, rebuild all of it.
