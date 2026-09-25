import { runStoreConformanceTests } from '@noy-db/ports/to'
import { toMemory } from '../src/index.js'

runStoreConformanceTests('memory', async () => toMemory())
