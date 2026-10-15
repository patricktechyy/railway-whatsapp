import zlib from 'node:zlib'

/**
 * Squeeze a text response (HTML, JSON, JS, CSS) when the browser says it can unpack it.
 * The chat list alone is ~150 KB of JSON and is fetched on every new message; gzipped it's
 * a fifth of that. Set `res.gzipOk` from the request's Accept-Encoding before using this.
 */
const TEXTY = /^(text\/|application\/(json|javascript|manifest\+json)|image\/svg)/
export function gzipped(res, body, headers) {
  if (!res.gzipOk || body == null) return { body, headers }
  const type = String(headers['content-type'] || '')
  const size = typeof body === 'string' ? Buffer.byteLength(body) : body.length
  if (size < 1400 || !TEXTY.test(type) || headers['content-encoding']) return { body, headers }
  return { body: zlib.gzipSync(body, { level: 6 }), headers: { ...headers, 'content-encoding': 'gzip', vary: 'Accept-Encoding' } }
}
