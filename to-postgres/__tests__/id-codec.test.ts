import { idCodecSuite } from './_id-codec.js'
import { mockClient } from './_mock.js'

idCodecSuite('@noy-db/to-postgres (mock)', () => {
  const client = mockClient()
  return {
    client,
    async seedRaw(vault, collection, id, envelope) {
      client.rows.set(`${vault}\x00${collection}\x00${id}`, { vault, collection, id, v: envelope._v, envelope })
    },
  }
})
