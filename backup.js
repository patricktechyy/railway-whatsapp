import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'

/**
 * Backup: the whole data volume as one .tar.gz, streamed straight to the admin's
 * browser (nothing extra is written to the volume). It's a normal tar archive, so
 * it opens on any computer, and restoring is copying the files back into /data.
 *
 * No library needed: tar is 512-byte headers followed by the file's bytes, padded
 * to 512. Long paths get a GNU "long name" entry first.
 */

const SKIP = /\.tmp$|\.lock$/ // half-written files mid-save

function header(name, size, mtime, type = '0', mode = 0o644) {
  const h = Buffer.alloc(512)
  const put = (s, off, len) => h.write(String(s), off, Math.min(Buffer.byteLength(String(s)), len), 'utf8')
  const oct = (n, len) => n.toString(8).padStart(len - 1, '0') + '\0'
  put(name.slice(0, 100), 0, 100)
  h.write(oct(mode, 8), 100, 8, 'ascii')
  h.write(oct(0, 8), 108, 8, 'ascii')
  h.write(oct(0, 8), 116, 8, 'ascii')
  h.write(oct(size, 12), 124, 12, 'ascii')
  h.write(oct(Math.floor(mtime / 1000), 12), 136, 12, 'ascii')
  h.write('        ', 148, 8, 'ascii') // checksum is computed with spaces here
  h.write(type, 156, 1, 'ascii')
  h.write('ustar  \0', 257, 8, 'ascii') // GNU magic (allows the long-name entries)
  let sum = 0
  for (const b of h) sum += b
  h.write(sum.toString(8).padStart(6, '0') + '\0 ', 148, 8, 'ascii')
  return h
}
const pad = (n) => Buffer.alloc((512 - (n % 512)) % 512)

function* walk(root, rel = '') {
  let entries = []
  try { entries = fs.readdirSync(path.join(root, rel), { withFileTypes: true }) } catch { return }
  for (const e of entries) {
    const r = rel ? `${rel}/${e.name}` : e.name
    if (e.isDirectory()) yield* walk(root, r)
    else if (e.isFile() && !SKIP.test(e.name)) yield r
  }
}

/** Stream `root` as a gzipped tar into `out` (an http response). Resolves with { files, bytes }. */
export async function streamBackup(root, out, prefix = 'data') {
  const gz = zlib.createGzip({ level: 6 })
  gz.pipe(out)
  // the download was cancelled (or the connection dropped): stop, don't wait for it forever
  let aborted = false, wake = null
  const abort = () => { if (aborted) return; aborted = true; gz.destroy(); wake?.() }
  out.on('close', () => { if (!out.writableFinished) abort() })
  const write = (buf) => {
    if (aborted) return null
    return gz.write(buf) ? null : new Promise((r) => { wake = r; gz.once('drain', () => { wake = null; r() }) })
  }
  let files = 0, bytes = 0
  for (const rel of walk(root)) {
    if (aborted) break
    let data, st
    try {
      st = fs.statSync(path.join(root, rel))
      data = fs.readFileSync(path.join(root, rel)) // read whole: a file saved mid-backup can't come out torn
    } catch { continue }
    const name = `${prefix}/${rel}`
    if (Buffer.byteLength(name) > 99) {
      const long = Buffer.from(name + '\0')
      await write(header('././@LongLink', long.length, 0, 'L'))
      await write(long); await write(pad(long.length))
    }
    await write(header(name, data.length, st.mtimeMs, '0', 0o600))
    await write(data); await write(pad(data.length))
    files++; bytes += data.length
  }
  if (aborted) return { files, bytes, aborted: true }
  await write(Buffer.alloc(1024)) // two empty blocks end the archive
  await new Promise((r) => gz.end(r))
  return { files, bytes }
}
