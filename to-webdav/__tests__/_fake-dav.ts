/**
 * In-memory WebDAV server behind a `fetch` implementation, for the
 * conformance suite (#26). Models what the store emits: PUT/GET/DELETE on
 * `.json` leaves, MKCOL (idempotent), and PROPFIND Depth 0/1 answering 207
 * multi-status XML with `<d:href>` entries (self + immediate children),
 * hrefs percent-encoded exactly as a real server echoes them.
 */
export function fakeDav(): { fetch: typeof fetch; files: Map<string, string> } {
  // Keys are decoded pathname segments joined with '/', e.g.
  // 'vault/collection/id.json'.
  const files = new Map<string, string>()
  const dirs = new Set<string>()

  const res = (status: number, body = '', headers: Record<string, string> = {}) =>
    new Response(body || null, { status, headers })

  const encodePath = (decoded: string) =>
    decoded.split('/').map(encodeURIComponent).join('/')

  const impl = (async (rawUrl: unknown, init?: { method?: string; body?: string }) => {
    const url = new URL(String(rawUrl))
    const method = init?.method ?? 'GET'
    const decodedPath = url.pathname
      .replace(/\/+$/, '')
      .split('/')
      .filter(Boolean)
      .map(decodeURIComponent)
      .join('/')

    if (method === 'PUT') {
      files.set(decodedPath, init?.body ?? '')
      return res(201)
    }
    if (method === 'GET') {
      const body = files.get(decodedPath)
      return body === undefined ? res(404) : res(200, body)
    }
    if (method === 'DELETE') {
      if (!files.has(decodedPath)) return res(404)
      files.delete(decodedPath)
      return res(204)
    }
    if (method === 'MKCOL') {
      dirs.add(decodedPath)
      return res(201)
    }
    if (method === 'PROPFIND') {
      // Depth 0 (ping) answers for any path; Depth 1 lists children.
      const children = new Set<string>()
      const prefix = decodedPath ? decodedPath + '/' : ''
      for (const f of files.keys()) {
        if (!f.startsWith(prefix)) continue
        const rest = f.slice(prefix.length)
        if (rest) children.add(rest.split('/')[0]!)
      }
      for (const d of dirs) {
        if (!d.startsWith(prefix) || d === decodedPath) continue
        const rest = d.slice(prefix.length)
        if (rest && !rest.includes('/')) children.add(rest)
      }
      if (children.size === 0 && decodedPath && !dirs.has(decodedPath) && !files.has(decodedPath)) {
        return res(404)
      }
      const selfHref = '/' + encodePath(decodedPath) + (decodedPath ? '/' : '')
      const hrefs = [selfHref, ...[...children].map(c => {
        const childDecoded = prefix + c
        const isLeaf = files.has(childDecoded)
        return '/' + encodePath(childDecoded) + (isLeaf ? '' : '/')
      })]
      const xml = `<?xml version="1.0" encoding="utf-8"?>\n<d:multistatus xmlns:d="DAV:">` +
        hrefs.map(h => `<d:response><d:href>${h}</d:href></d:response>`).join('') +
        `</d:multistatus>`
      return res(207, xml, { 'Content-Type': 'application/xml' })
    }
    return res(405)
  }) as unknown as typeof fetch

  return { fetch: impl, files }
}
