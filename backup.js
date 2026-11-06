import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import zlib from 'node:zlib'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { Worker } from 'node:worker_threads'

/**
 * Backup: the whole data volume as one .tar.gz, streamed straight to the admin's
 * browser (nothing extra is written to the volume). It's a normal tar archive, so
 * it opens on any computer, and restoring is copying the files back into /data
 * (with the server stopped).
 *
 * No library needed: tar is 512-byte headers followed by the file's bytes, padded
 * to 512. Long paths get a GNU "long name" entry first.
 *
 * Each account's messages.db is a live database, so it isn't copied as it lies: a consistent copy is
 * made first (VACUUM INTO, which sees the last saved state) in the system's temp folder, goes into the
 * archive under the same name, and is deleted again. Its -wal and -shm files are left out.
 */

// half-written files mid-save, a database's side files, and the old store.json kept after the move to the database
const SKIP = /\.tmp$|\.lock$|\.db-wal$|\.db-shm$|\.migrated$/
const CHUNK = 256 * 1024

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
  for (const e of fs.readdirSync(path.join(root, rel), { withFileTypes: true })) {
    const r = rel ? `${rel}/${e.name}` : e.name
    if (e.isDirectory()) yield* walk(root, r)
    else if (e.isFile() && !SKIP.test(e.name)) yield r
  }
}

/** A consistent copy of a live database without blocking the server or its commit timers. */
function snapshotDb(file, out) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./backup-worker.js', import.meta.url), { workerData: { file, out } })
    let error
    worker.once('error', (e) => { error = e })
    worker.once('exit', (code) => {
      if (code === 0) resolve()
      else reject(new Error(`Could not back up ${file}: ${error?.message || `worker exited with code ${code}`}`, { cause: error }))
    })
  })
}

/** Stream `root` as a gzipped tar into `out` (an http response). Resolves with { files, bytes }. */
export async function streamBackup(root, out, prefix = 'data') {
  let files = 0, bytes = 0
  async function* archive() {
    for (const rel of walk(root)) {
      let file = path.join(root, rel)
      let temp
      let fd
      try {
        if (path.basename(rel) === 'messages.db') {
          temp = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'wa-backup-'))
          const copy = path.join(temp, 'messages.db')
          await snapshotDb(file, copy)
          file = copy
        }
        // Stat and read the same open file even if a save replaces the path midway through.
        fd = await fs.promises.open(file, 'r')
        const { size, mtimeMs } = await fd.stat()
        const name = `${prefix}/${rel}`
        if (Buffer.byteLength(name) > 99) {
          const long = Buffer.from(name + '\0')
          yield header('././@LongLink', long.length, 0, 'L')
          yield long
          yield pad(long.length)
        }
        yield header(name, size, mtimeMs, '0', 0o600)
        let left = size
        while (left > 0) {
          const buf = Buffer.allocUnsafe(Math.min(left, CHUNK))
          const { bytesRead } = await fd.read(buf)
          if (!bytesRead) throw new Error(`File shrank during backup: ${rel}`)
          yield buf.subarray(0, bytesRead)
          left -= bytesRead
        }
        yield pad(size)
        files++
        bytes += size
      } finally {
        try { await fd?.close() } finally {
          if (temp) await fs.promises.rm(temp, { recursive: true, force: true })
        }
      }
    }
    yield Buffer.alloc(1024) // two empty blocks end the archive
  }
  try {
    await pipeline(Readable.from(archive(), { objectMode: false }), zlib.createGzip({ level: 6 }), out)
  } catch (e) {
    if (e.code === 'ERR_STREAM_PREMATURE_CLOSE') return { files, bytes, aborted: true }
    throw e
  }
  return { files, bytes }
}
