import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { HttpError } from './auth.js'

/**
 * Pictures, videos and recordings pass through the server as files, not as buffers in memory: a download
 * is written to a temporary file as it arrives and sent from there, an upload is written to one as it
 * comes in and handed to WhatsApp from there. They live in one folder, so a start-up can clear out what
 * a crash left behind, and a sweep can catch anything that was forgotten.
 */
export const SPOOL = path.join(os.tmpdir(), 'wa-spool')

/** A new, unused path in the spool folder. */
export function spoolFile(ext = '') {
  fs.mkdirSync(SPOOL, { recursive: true })
  return path.join(SPOOL, `${Date.now().toString(36)}-${crypto.randomBytes(6).toString('hex')}${ext}`)
}

/** A new folder in the spool folder (for a job that makes several files). */
export function spoolDir(prefix = '') {
  fs.mkdirSync(SPOOL, { recursive: true })
  return fs.mkdtempSync(path.join(SPOOL, prefix))
}

/** Delete files or folders, quietly. */
export function drop(...paths) {
  for (const p of paths) {
    if (p) {
      try { fs.rmSync(p, { recursive: true, force: true }) } catch {}
    }
  }
}

/** At start-up: nothing is in flight yet, so whatever is here is left over. */
export function startSpool() {
  drop(SPOOL)
  fs.mkdirSync(SPOOL, { recursive: true })
}

/** Delete what has been lying around longer than `maxAgeMs` (a safety net; files are normally deleted right after use). */
export function sweepSpool(maxAgeMs = 3600e3) {
  let n = 0
  try {
    for (const e of fs.readdirSync(SPOOL, { withFileTypes: true })) {
      const p = path.join(SPOOL, e.name)
      try {
        if (Date.now() - fs.statSync(p).mtimeMs > maxAgeMs) { drop(p); n++ }
      } catch {}
    }
  } catch {}
  return n
}

/**
 * Write the body of a request to a file as it arrives, refusing anything over `limit` bytes.
 * Resolves with { file, size }; the caller deletes the file. Nothing is left behind on an error.
 */
export async function bodyToFile(req, limit) {
  const tooBig = () => new HttpError(413, `File too large (max ${Math.round(limit / 1048576)} MB)`)
  if (Number(req.headers['content-length'] || 0) > limit) throw tooBig()
  const file = spoolFile()
  let size = 0
  const count = new Transform({
    transform(chunk, _enc, cb) {
      size += chunk.length
      if (size > limit) cb(tooBig())
      else cb(null, chunk)
    },
  })
  try {
    await pipeline(req, count, fs.createWriteStream(file))
  } catch (e) {
    drop(file)
    throw e
  }
  return { file, size }
}

/**
 * A pass-through that fails if nothing comes through for `ms`. A download that stops half way (the
 * connection reset, say) is not reported as an error by the layers underneath; without this it would
 * wait for ever.
 */
export function idleGuard(ms, what = 'the download') {
  let timer = null
  const arm = (self) => {
    clearTimeout(timer)
    timer = setTimeout(() => self.destroy(new Error(`${what} stalled (nothing came through for ${Math.round(ms / 1000)} s)`)), ms)
  }
  return new Transform({
    construct(cb) { arm(this); cb() },
    transform(chunk, _enc, cb) { arm(this); cb(null, chunk) },
    flush(cb) { clearTimeout(timer); cb() },
    destroy(err, cb) { clearTimeout(timer); cb(err) },
  })
}
