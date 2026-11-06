import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Readable } from 'node:stream'
import { register } from 'node:module'

// Pictures, videos and recordings pass through as files, never as buffers in memory. These settings are read
// when session.js loads, so they come first: a stalled download is noticed after 150 ms, two attempts each.
process.env.MEDIA_IDLE_MS = '150'
process.env.MEDIA_DOWNLOAD_ATTEMPTS = '2'
process.env.FFMPEG = 'no-such-ffmpeg-for-the-tests'
register('./fixtures/stub-hooks.mjs', import.meta.url)
const { Session, waveOf, waveOfFile, oneAtATime } = await import('../session.js')
const { SPOOL, spoolFile, bodyToFile, drop, startSpool, sweepSpool, idleGuard } = await import('../spool.js')

const ME = '6580000009@s.whatsapp.net'
const A = '6581111111@s.whatsapp.net'
const B = '6582222222@s.whatsapp.net'
const now = () => Math.floor(Date.now() / 1000)
const made = []
const left = () => (fs.existsSync(SPOOL) ? fs.readdirSync(SPOOL).sort() : [])
const bytesOf = (n, seed = 1) => Buffer.from(Array.from({ length: n }, (_, i) => (i * 31 + seed) & 255))
const reqOf = (chunks, headers = {}) => Object.assign(Readable.from(chunks), { headers })
test.after(() => {
  for (const d of made) {
    try { fs.rmSync(d, { recursive: true, force: true }) } catch {}
  }
})
startSpool()

function account() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-media-'))
  made.push(dir)
  const s = new Session({ key: 'anna', label: 'Anna', dir })
  s.me = { jid: ME, lid: null, phone: '+6580000009', name: 'Anna' }
  s.status = 'connected'
  const sent = []
  let n = 0
  s.sock = {
    sendPresenceUpdate: async () => {},
    sendMessage: async (to, content) => {
      // whatever WhatsApp is given has to be there to read at this moment
      for (const k of ['image', 'video', 'audio', 'document', 'sticker']) {
        if (content[k]?.url) sent.push({ to, kind: k, path: content[k].url, existed: fs.existsSync(content[k].url), size: fs.existsSync(content[k].url) ? fs.statSync(content[k].url).size : -1, content })
      }
      const id = `OUT${++n}`
      return { key: { remoteJid: to, id, fromMe: true }, messageTimestamp: now(), message: { conversation: content.text || content.caption || 'media' } }
    },
  }
  return { s, sent }
}
function photo(s, id, extra = {}) {
  s.store.addMessage({
    id, jid: A, fromMe: false, ts: now(), type: 'image', text: '',
    rm: { key: { remoteJid: A, id }, message: { imageMessage: { mimetype: 'image/jpeg', fileName: 'p.jpg', url: 'https://example.invalid/x', mediaKey: { $b: 'AQID' } } } },
    ...extra,
  })
}
const downloads = (impl) => {
  const state = { calls: 0 }
  globalThis.__baileys = { downloadMediaMessage: async (...a) => { state.calls++; return impl(state.calls, ...a) } }
  return state
}

// ---------------------------------------------------------------- the spool
test('an upload goes to a file as it arrives, with its size', async () => {
  const body = bytesOf(3 * 65536 + 17)
  const { file, size } = await bodyToFile(reqOf([body.subarray(0, 100000), body.subarray(100000)]), 1 << 20)
  assert.equal(size, body.length)
  assert.ok(fs.readFileSync(file).equals(body))
  assert.ok(file.startsWith(SPOOL))
  drop(file)
  assert.equal(fs.existsSync(file), false)
})

test('an upload over the limit is refused, whether it says so up front or only shows it as it comes, and leaves nothing behind', async () => {
  const before = left()
  await assert.rejects(bodyToFile(reqOf([bytesOf(10)], { 'content-length': '5000000' }), 1000), (e) => e.status === 413 && /max/.test(e.message))
  await assert.rejects(bodyToFile(reqOf([bytesOf(600), bytesOf(600)]), 1000), (e) => e.status === 413)
  assert.deepEqual(left(), before)
})

test('an upload cut off half way leaves nothing behind', async () => {
  const before = left()
  const broken = new Readable({ read() { this.push(bytesOf(1000)); this.destroy(new Error('connection reset')) } })
  broken.headers = {}
  await assert.rejects(bodyToFile(broken, 1 << 20), /reset|closed|premature/i)
  assert.deepEqual(left(), before)
})

test('sweeping removes what has lain around too long, and only that', () => {
  const old = spoolFile('.old')
  const fresh = spoolFile('.fresh')
  fs.writeFileSync(old, 'x')
  fs.writeFileSync(fresh, 'x')
  const past = new Date(Date.now() - 2 * 3600e3)
  fs.utimesSync(old, past, past)
  assert.equal(sweepSpool(3600e3), 1)
  assert.equal(fs.existsSync(old), false)
  assert.equal(fs.existsSync(fresh), true)
  drop(fresh)
})

test('a download that stops half way is noticed', async () => {
  const stalled = new Readable({ read() {} })
  const { pipeline } = await import('node:stream/promises')
  stalled.push(Buffer.from('some'))
  await assert.rejects(pipeline(stalled, idleGuard(100), fs.createWriteStream(spoolFile())), /stalled/)
  assert.equal(left().length, 1) // (the empty file the test itself made)
  startSpool()
})

// ------------------------------------------------------------------ downloads
test('a download is written to a file and read from there; releasing it deletes it', async () => {
  startSpool()
  const { s } = account()
  photo(s, 'img1')
  const body = bytesOf(200000, 7)
  downloads(() => Readable.from([body.subarray(0, 70000), body.subarray(70000)]))
  const out = await s.media(A, 'img1')
  assert.equal(out.size, body.length)
  assert.equal(out.mime, 'image/jpeg')
  assert.equal(out.fileName, 'p.jpg')
  assert.ok(fs.readFileSync(out.path).equals(body))
  assert.ok(out.path.startsWith(SPOOL))
  out.release()
  out.release() // twice does no harm
  assert.equal(fs.existsSync(out.path), false)
  assert.deepEqual(left(), [])
  s.shutdown()
})

test('a message with nothing to download gives null', async () => {
  const { s } = account()
  s.store.addMessage({ id: 'plain', jid: A, fromMe: false, ts: now(), type: 'text', text: 'hi' })
  downloads(() => { throw new Error('must not be asked') })
  assert.equal(await s.media(A, 'plain'), null)
  assert.equal(await s.media(A, 'missing'), null)
  s.shutdown()
})

test('people asking for the same picture at the same time share one download, and the file lives until the last is done', async () => {
  startSpool()
  const { s } = account()
  photo(s, 'img2')
  photo(s, 'img3')
  const body = bytesOf(50000)
  const state = downloads(async () => { await new Promise((r) => setTimeout(r, 60)); return Readable.from([body]) })
  const [a, b, c] = await Promise.all([s.media(A, 'img2'), s.media(A, 'img2'), s.media(A, 'img2')])
  assert.equal(state.calls, 1)
  assert.equal(a.path, b.path)
  assert.equal(b.path, c.path)
  a.release()
  b.release()
  assert.ok(fs.existsSync(c.path), 'still needed by the third')
  c.release()
  assert.equal(fs.existsSync(c.path), false)
  // another picture is a different download; and once everyone is done, asking again fetches again
  const [d] = await Promise.all([s.media(A, 'img3'), s.media(A, 'img2').then((x) => x.release())])
  assert.equal(state.calls, 3)
  d.release()
  assert.deepEqual(left(), [])
  s.shutdown()
})

test('a failed download is tried again, and a failure leaves no half-written file', async () => {
  startSpool()
  const { s } = account()
  photo(s, 'img4')
  const body = bytesOf(9000)
  const state = downloads((n) => {
    if (n === 1) {
      const broken = new Readable({ read() { this.push(bytesOf(100)); this.destroy(new Error('decrypt failed')) } })
      return broken
    }
    return Readable.from([body])
  })
  const out = await s.media(A, 'img4')
  assert.equal(state.calls, 2)
  assert.ok(fs.readFileSync(out.path).equals(body))
  assert.equal(left().length, 1, 'only the good file')
  out.release()
  assert.deepEqual(left(), [])
  s.shutdown()
})

test('a download that never finishes fails after its tries instead of waiting for ever, and can be asked for again', async () => {
  startSpool()
  const { s } = account()
  photo(s, 'img5')
  let calls = 0
  globalThis.__baileys = {
    downloadMediaMessage: async () => {
      calls++
      const r = new Readable({ read() {} })
      r.push(bytesOf(500)) // some of it comes, then nothing
      return r
    },
  }
  await assert.rejects(s.media(A, 'img5'), /stalled/)
  assert.equal(calls, 2)
  assert.deepEqual(left(), [])
  assert.match(s.metrics.lastMediaError.error, /stalled/)
  // the failure was not kept: the next ask tries afresh
  downloads(() => Readable.from([bytesOf(10)]))
  const out = await s.media(A, 'img5')
  assert.equal(out.size, 10)
  out.release()
  s.shutdown()
})

// ---------------------------------------------------------------- uploads
test('a photo is sent from its file (with the thumbnail the browser made), not from memory', async () => {
  const { s, sent } = account()
  const file = spoolFile('.jpg')
  fs.writeFileSync(file, bytesOf(1234))
  const msg = await s.sendMedia(A, file, { mime: 'image/jpeg', name: 'p.jpg', caption: 'look', thumb: Buffer.from('thumb') })
  assert.equal(msg.text, 'look')
  assert.equal(sent.length, 1)
  assert.equal(sent[0].kind, 'image')
  assert.equal(sent[0].path, file)
  assert.equal(sent[0].existed, true)
  assert.equal(sent[0].size, 1234)
  assert.equal(sent[0].content.jpegThumbnail.toString(), 'thumb')
  assert.ok(fs.existsSync(file), 'the caller deletes it')
  drop(file)
  s.shutdown()
})

test('any other file goes as a document, from its file', async () => {
  const { s, sent } = account()
  const file = spoolFile('.pdf')
  fs.writeFileSync(file, bytesOf(777))
  await s.sendMedia(A, file, { mime: 'application/pdf', name: 'a.pdf' })
  assert.equal(sent[0].kind, 'document')
  assert.equal(sent[0].content.fileName, 'a.pdf')
  assert.equal(sent[0].content.mimetype, 'application/pdf')
  assert.equal(sent[0].size, 777)
  drop(file)
  s.shutdown()
})

test('without ffmpeg an Ogg voice message and an MP4 video message are sent as they are, anything else is refused', async () => {
  const { s, sent } = account()
  const ogg = spoolFile('.ogg')
  fs.writeFileSync(ogg, bytesOf(300))
  await s.sendVoiceNote(A, ogg, { mime: 'audio/ogg', seconds: '3' })
  assert.equal(sent[0].kind, 'audio')
  assert.equal(sent[0].path, ogg)
  assert.equal(sent[0].content.ptt, true)
  assert.equal(sent[0].content.seconds, 3)
  assert.ok(fs.existsSync(ogg), 'the recording is the caller\'s to delete')

  const mp4 = spoolFile('.mp4')
  fs.writeFileSync(mp4, bytesOf(400))
  await s.sendVideoNote(A, mp4, { mime: 'video/mp4', seconds: '5' })
  assert.equal(sent[1].kind, 'video')
  assert.equal(sent[1].path, mp4)
  assert.equal(sent[1].content.ptv, true)
  assert.ok(fs.existsSync(mp4))

  await assert.rejects(s.sendVoiceNote(A, ogg, { mime: 'audio/webm' }), (e) => e.status === 415)
  await assert.rejects(s.sendVideoNote(A, mp4, { mime: 'video/webm' }), (e) => e.status === 415)
  assert.equal(sent.length, 2)
  drop(ogg, mp4)
  s.shutdown()
})

// --------------------------------------------------------------- forwarding
test('forwarding media downloads it once, sends it to every chat from the file, and cleans up', async () => {
  startSpool()
  const { s, sent } = account()
  photo(s, 'fw1', { text: 'caption' })
  const body = bytesOf(30000, 3)
  const state = downloads(() => Readable.from([body]))
  const r = await s.forward(A, ['fw1'], [B, '6583333333@s.whatsapp.net'])
  assert.equal(r.failed, 0)
  assert.equal(r.sent, 2)
  assert.equal(state.calls, 1)
  // the first chat gets the picture from the file; the second a forward of that copy
  assert.equal(sent[0].kind, 'image')
  assert.equal(sent[0].existed, true)
  assert.equal(sent[0].size, body.length)
  assert.equal(sent[0].content.caption, 'caption')
  assert.deepEqual(left(), [])
  s.shutdown()
})

test('forwarding something that cannot be fetched fails that message and leaves nothing behind', async () => {
  startSpool()
  const { s } = account()
  photo(s, 'fw2')
  globalThis.__baileys = { downloadMediaMessage: async () => { throw new Error('gone from the server') } }
  const r = await s.forward(A, ['fw2'], [B])
  assert.equal(r.sent, 0)
  assert.equal(r.failed, 1)
  assert.match(r.error, /gone from the server/)
  assert.deepEqual(left(), [])
  s.shutdown()
})

// ------------------------------------------------------------ recordings
test('the waveform read from a file is the same as the one worked out in memory', () => {
  for (const samples of [1, 63, 64, 65, 500, 4001, 40000, 70001]) {
    const pcm = Buffer.alloc(samples * 2)
    for (let i = 0; i < samples; i++) pcm.writeInt16LE(Math.round(Math.sin(i / 7) * (i % 3000) * 8) % 32768, i * 2)
    const file = spoolFile('.raw')
    fs.writeFileSync(file, pcm)
    assert.deepEqual(waveOfFile(file), waveOf(pcm), `${samples} samples`)
    drop(file)
  }
  const empty = spoolFile('.raw')
  fs.writeFileSync(empty, '')
  assert.equal(waveOfFile(empty), null)
  drop(empty)
})

test('ffmpeg jobs run one at a time, in the order they came, and a failure does not stop the next', async () => {
  const log = []
  const job = (name, ms, fail) => oneAtATime(async () => {
    log.push(`start ${name}`)
    await new Promise((r) => setTimeout(r, ms))
    log.push(`end ${name}`)
    if (fail) throw new Error(name)
    return name
  })
  const results = await Promise.allSettled([job('a', 40), job('b', 5, true), job('c', 5)])
  assert.deepEqual(log, ['start a', 'end a', 'start b', 'end b', 'start c', 'end c'])
  assert.deepEqual(results.map((r) => r.status), ['fulfilled', 'rejected', 'fulfilled'])
})
