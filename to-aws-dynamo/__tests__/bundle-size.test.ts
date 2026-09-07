/**
 * Bundle-size sanity for the direct-to-cloud browser/LIFF client (#17).
 *
 * ⚠️ The number that matters is NOT this package's own size. Measured:
 * `dist/index.js` is ~11 KB, while `@aws-sdk/client-dynamodb` plus
 * `lib-dynamodb` are ~2.0 MB on disk. A browser's cost is almost entirely the SDK — which is a PEER the consumer
 * installs and tree-shakes with their own bundler, so it is not ours to
 * budget and a threshold on it would be someone else's number.
 *
 * What IS ours, and what this file asserts, is that the peer stays EXTERNAL.
 * `tsup.config.ts` declares no explicit `external`; externalisation is an
 * implicit consequence of the SDK being a `peerDependency`, which tsup
 * honours by default. Nothing tested that. A build-config change — a
 * `noExternal`, or moving the SDK out of peers — would inline megabytes into
 * every consumer's bundle, and **every existing test would still pass**: the
 * store behaves identically either way.
 *
 * So the load-bearing assertion is the INVARIANT (every declared peer is
 * imported, not inlined), derived from `package.json` rather than from a
 * hardcoded list — a new peer is covered the day it is added. The byte
 * budget below is secondary and deliberately loose: its only job is to catch
 * catastrophic inlining, so it must never be a number anyone edits routinely.
 */
import { describe, expect, it } from 'vitest'
import { readFileSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const pkgRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
const distPath = join(pkgRoot, 'dist', 'index.js')
// ⚠️ Deliberately NOT `describe.runIf(existsSync(...))`. A guard that
// silently skips when `dist/` is missing is indistinguishable from one
// that passed — the exact collapse this file exists to prevent. CI runs
// `pnpm build` before `pnpm test`, so this holds there; locally it asks
// for the build rather than quietly proving nothing.
if (!existsSync(distPath)) {
  throw new Error(`@noy-db/to-aws-dynamo: dist/index.js is missing — run \`pnpm build\` before \`pnpm test\`. `
    + 'This check reads the BUILT output; skipping it would hide an inlined peer.')
}

const pkg = JSON.parse(readFileSync(join(pkgRoot, 'package.json'), 'utf8')) as {
  peerDependencies?: Record<string, string>
}

/**
 * Catastrophe threshold, not a budget. The bundle is ~11 KB; inlining the
 * smallest AWS SDK client would blow past this by two orders of magnitude.
 * If it ever trips, the question is "which peer got inlined", never "should
 * we raise the limit".
 */
const CATASTROPHE_BYTES = 200_000

describe('to-aws-dynamo — bundle sanity (#17)', () => {
  const dist = readFileSync(distPath, 'utf8')
  const peers = Object.keys(pkg.peerDependencies ?? {})

  it('declares peers to assert against (guards the guard)', () => {
    // Without this, an empty peer list would make the loop below vacuous and
    // this file would pass while asserting nothing at all.
    expect(peers.length).toBeGreaterThan(0)
    expect(peers).toContain('@aws-sdk/client-dynamodb')
    expect(peers).toContain('@aws-sdk/lib-dynamodb')
  })

  it.each(Object.keys(pkg.peerDependencies ?? {}))('keeps %s external — imported, never inlined', (peer) => {
    // Static (`from "peer"`) or dynamic (`import("peer")`) — this package
    // loads the SDK by dynamic import to keep it a true peer, so the dynamic
    // form is the one that matters here; both count as external.
    // Subpaths count too: the hub peer is bound as `@noy-db/hub/to`, never
    // as the bare specifier, and requiring an exact match failed on it.
    const spec = `${peer}(/[^"']+)?`
    const referenced = new RegExp(`(from\\s*["']${spec}["']|import\\(["']${spec}["']\\))`).test(dist)
    expect(referenced, `${peer} is not imported from dist — it may have been inlined`).toBe(true)
  })

  it('stays far below the size at which a peer must have been inlined', () => {
    expect(Buffer.byteLength(dist)).toBeLessThan(CATASTROPHE_BYTES)
  })

  it('ships no Node-only builtin imports, so it can run in a browser/WebView', () => {
    // The other half of the #17 audit, asserted rather than eyeballed.
    const nodeBuiltin = /(from\s*["']node:[a-z_]+["']|require\(["'](fs|path|crypto|os|net|tls)["']\))/
    expect(nodeBuiltin.test(dist), 'dist references a Node builtin').toBe(false)
  })
})
