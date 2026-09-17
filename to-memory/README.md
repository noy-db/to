# @noy-db/to-memory

> In-memory adapter for [noy-db](https://github.com/noy-db/core), shipped from [noy-db-to](https://github.com/noy-db/to) — ideal for testing and ephemeral workloads.

[![npm](https://img.shields.io/npm/v/@noy-db/to-memory.svg)](https://www.npmjs.com/package/@noy-db/to-memory)

## Install

```bash
pnpm add @noy-db/hub @noy-db/to-memory
```

## Usage

```ts
import { createNoydb } from '@noy-db/hub'
import { toMemory } from '@noy-db/to-memory'

const db = await createNoydb({
  store: toMemory(),
  user: 'alice',
  secret: 'correct horse battery staple',
})
```

Data lives only in the current process — it's gone when the process exits. Perfect for:

- Unit and integration tests
- Short-lived scripts
- Benchmarks
- Prototyping before wiring up persistent storage

## License

Apache-2.0 © vLannaAi — see the [noy-db repo](https://github.com/noy-db/core) for full documentation.
