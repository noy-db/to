import { runStoreConformanceTests } from '@noy-db/test-adapter-conformance'
import { toBrowserLocal } from '../src/index.js'

// Run conformance suite against localStorage backend
runStoreConformanceTests(
  'store-browser-local',
  async () => {
    // Clear localStorage before each test factory call
    localStorage.clear()
    return toBrowserLocal({ prefix: `test-${Date.now()}` })
  },
  async () => {
    localStorage.clear()
  },
)
