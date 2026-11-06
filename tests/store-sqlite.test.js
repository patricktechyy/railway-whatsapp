import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import zlib from 'node:zlib'
import { PassThrough } from 'node:stream'
import { DatabaseSync } from 'node:sqlite'
import { Store, migrateLegacy, historyCutoff } from '../store.js'
import { streamBackup } from '../backup.js'

// What is new with messages in a database: moving the old store.json over, saving, recovery, the backup.

const A = '6581111111@s.whatsapp.net'
const B = '6582222222@s.whatsapp.net'
const LID = '12345678901@lid'
const G = '120363000000000001@g.us'
const now = () => Math.floor(Date.now() / 1000)
const msg = (o) => ({ id: 'm1', jid: A, fromMe: false, ts: now(), type: 'text', text: 'hi', ...o })
const ids = (list) => list.map((m) => m.id)
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'wa-sql-'))
const made = []
function dir() {
  const d = tmp()
  made.push(d)
  return d
}
function open(d = dir()) {
  return new Store(path.join(d, 'store.json'))
}
test.after(() => {
  for (const d of made) {
    try { fs.rmSync(d, { recursive: true, force: true }) } catch {} // (Windows keeps a folder while a database in it is open)
  }
})

function legacyFile(d, extra = {}) {
  const t = now()
  const file = path.join(d, 'store.json')
  fs.writeFileSync(file, JSON.stringify({
    chats: [{ jid: A, t, unread: 2, preview: 'two' }, { jid: G, t, unread: 0, preview: 'g' }],
    contacts: [[A, { name: 'Anna' }]],
    alias: [[LID, B]],
    gone: ['old-gone'],
    locked: [G],
    messages: {
      [A]: [
        { id: 'a1', jid: A, fromMe: false, ts: t - 5, type: 'text', text: 'one' },
        { id: 'a2', jid: A, fromMe: false, ts: t, type: 'text', text: 'two', rs: 1 },
        { id: 'a2', jid: A, fromMe: false, ts: t, type: 'text', text: 'duplicate id' },
      ],
      [G]: [
        { id: 'g1', jid: G, fromMe: false, ts: t - 2, type: 'text', text: 'orig' },
        { id: 'g2', jid: G, fromMe: false, ts: t - 1, type: 'text', text: 'reply', sender: B, quote: { id: 'g1', sender: A, fromMe: false } },
      ],
    },
    ...extra,
  }))
  return file
}

test('migration: the old store.json is moved into the database and then deleted', () => {
  const d = dir()
  legacyFile(d)
  const s = open(d)
  assert.deepEqual(ids(s.allMessages(A)), ['a1', 'a2'])
  assert.equal(s.findMessage(A, 'a2').text, 'two') // the first of two with the same id wins
  assert.equal(s.count(), 4)
  assert.equal(s.chats.get(A).unread, 2)
  assert.equal(s.contacts.get(A).name, 'Anna')
  assert.equal(s.alias.get(LID), B)
  assert.ok(s.gone.has('old-gone'))
  assert.ok(s.isLocked(G))
  assert.equal(s.findMessage(G, 'g1').sender, A) // the reply told us who wrote it
  assert.deepEqual(s.receiptBatch(A, 10).map((m) => m.id), ['a1']) // a2 already had its read receipt
  assert.ok(!fs.existsSync(path.join(d, 'store.json.migrated')), 'no second copy is kept')
  assert.ok(!fs.existsSync(path.join(d, 'store.json')))
  assert.ok(fs.existsSync(path.join(d, 'chat-meta.json')))
  s.close()
  // next time it just opens
  const again = open(d)
  assert.equal(again.count(), 4)
  assert.equal(migrateLegacy(path.join(d, 'store.json')), false)
  again.close()
})

test('migration: starting over after a crash half way gives the same result', () => {
  const d = dir()
  legacyFile(d)
  // what an interrupted attempt leaves behind: a database with something in it, and no chat-meta.json yet
  const stale = new DatabaseSync(path.join(d, 'messages.db'))
  stale.exec('CREATE TABLE msg (seq INTEGER PRIMARY KEY, jid TEXT, id TEXT, ts INTEGER, doc TEXT)')
  stale.exec("INSERT INTO msg (jid, id, ts, doc) VALUES ('x', 'stale', 1, '{}')")
  stale.close()
  const s = open(d)
  assert.equal(s.count(), 4)
  assert.equal(s.findMessage('x', 'stale'), null)
  s.close()
})

test('migration: the copy an earlier build kept (store.json.migrated) is removed when the account opens', () => {
  const d = dir()
  const first = open(d)
  first.addMessage(msg({ id: 'kept' }))
  first.close()
  fs.writeFileSync(path.join(d, 'store.json.migrated'), 'x'.repeat(1000))
  const s = open(d)
  assert.ok(!fs.existsSync(path.join(d, 'store.json.migrated')))
  assert.deepEqual(ids(s.allMessages(A)), ['kept'])
  s.close()
})

test('migration: a start that stopped after writing chat-meta.json but before deleting store.json finishes the job', () => {
  const d = dir()
  legacyFile(d)
  const s = open(d)
  s.close() // migrated; the old file is gone
  // put the situation back: the old file still there, chat-meta.json still marked as just migrated
  const meta = JSON.parse(fs.readFileSync(path.join(d, 'chat-meta.json'), 'utf8'))
  fs.writeFileSync(path.join(d, 'chat-meta.json'), JSON.stringify({ ...meta, migratedAt: Date.now() }))
  legacyFile(d)
  const again = open(d)
  assert.ok(!fs.existsSync(path.join(d, 'store.json')))
  assert.equal(again.count(), 4)
  again.close()
})

test('migration: an interrupted cleanup keeps the old copy when the replacement is missing or incomplete', () => {
  for (const makeEmptyDb of [false, true]) {
    const d = dir()
    const file = legacyFile(d)
    const before = fs.readFileSync(file, 'utf8')
    fs.writeFileSync(path.join(d, 'chat-meta.json'), JSON.stringify({ migratedAt: Date.now(), migratedMessages: 4 }))
    if (makeEmptyDb) {
      const db = new DatabaseSync(path.join(d, 'messages.db'))
      db.exec('CREATE TABLE msg (seq INTEGER PRIMARY KEY)')
      db.close()
    }
    assert.throws(() => open(d))
    assert.equal(fs.readFileSync(file, 'utf8'), before)
  }
})

test('migration: a leftover .migrated file is kept if its replacement cannot be opened', () => {
  const d = dir()
  const file = path.join(d, 'store.json.migrated')
  fs.renameSync(legacyFile(d), file)
  assert.throws(() => open(d))
  assert.ok(fs.existsSync(file))
})

test('migration: if the new database cannot be made, the old file is left exactly as it was', () => {
  const d = dir()
  const file = legacyFile(d)
  const before = fs.readFileSync(file, 'utf8')
  // a database that cannot be filled in properly: a folder where messages.db has to be
  fs.mkdirSync(path.join(d, 'messages.db'))
  assert.throws(() => open(d))
  assert.equal(fs.readFileSync(file, 'utf8'), before)
  assert.ok(!fs.existsSync(path.join(d, 'chat-meta.json')))
})

test('migration: when chat-meta.json is already there, a store.json lying around is left alone', () => {
  const d = dir()
  const first = open(d)
  first.addMessage(msg({ id: 'kept' }))
  first.close()
  const file = legacyFile(d)
  const before = fs.readFileSync(file, 'utf8')
  const s = open(d)
  assert.deepEqual(ids(s.allMessages(A)), ['kept'])
  assert.equal(fs.readFileSync(file, 'utf8'), before)
  s.close()
})

test('migration: an unreadable store.json is set aside and the account starts empty', () => {
  const d = dir()
  fs.writeFileSync(path.join(d, 'store.json'), '{ nope')
  const s = open(d)
  assert.equal(s.chats.size, 0)
  assert.ok(fs.existsSync(path.join(d, 'store.json.unreadable')))
  s.close()
})

test('a damaged database is moved aside and the account carries on with a fresh one', () => {
  const d = dir()
  fs.writeFileSync(path.join(d, 'messages.db'), 'this is not a database '.repeat(500))
  const s = open(d)
  assert.equal(s.count(), 0)
  s.addMessage(msg({ id: 'fresh' }))
  assert.equal(s.findMessage(A, 'fresh').text, 'hi')
  assert.ok(fs.existsSync(path.join(d, 'messages.db.damaged')))
  s.close()
})

test('close() saves what is pending; the data is there when it is opened again', () => {
  const d = dir()
  const s = open(d)
  for (let i = 0; i < 50; i++) s.addMessage(msg({ id: `m${i}`, ts: now() - 50 + i }))
  assert.equal(s.pending, true)
  s.close()
  const r = open(d)
  assert.equal(r.count(), 50)
  assert.equal(r.pending, false)
  r.close()
})

test('flush commits: a second connection sees the messages only after it', () => {
  const d = dir()
  const s = open(d)
  s.addMessage(msg({ id: 'later' }))
  const other = new DatabaseSync(path.join(d, 'messages.db'))
  assert.equal(other.prepare('SELECT COUNT(*) AS n FROM msg').get().n, 0)
  s.flush()
  assert.equal(other.prepare('SELECT COUNT(*) AS n FROM msg').get().n, 1)
  other.close()
  s.close()
})

test('a closed store does nothing and does not throw (a send can finish after the account is removed)', () => {
  const s = open()
  s.addMessage(msg({ id: 'x' }))
  s.close()
  assert.equal(s.findMessage(A, 'x'), null)
  assert.deepEqual(s.messageList(A, null, {}), [])
  assert.equal(s.saveMessage(msg({ id: 'x' })), false)
  assert.doesNotThrow(() => s.addMessage(msg({ id: 'y' })))
  assert.equal(s.count(), 0)
  assert.doesNotThrow(() => s.close())
})

test('findMessage hands out a copy: changes only stick when saved, and a deleted message stays gone', () => {
  const s = open()
  s.addMessage(msg({ id: 'x', text: 'one' }))
  const m = s.findMessage(A, 'x')
  m.text = 'changed'
  assert.equal(s.findMessage(A, 'x').text, 'one')
  assert.equal(s.saveMessage(m), true)
  assert.equal(s.findMessage(A, 'x').text, 'changed')
  // it was deleted while somebody held a copy
  const held = s.findMessage(A, 'x')
  s.removeMessage(A, 'x')
  held.text = 'back from the dead'
  assert.equal(s.saveMessage(held), false)
  assert.equal(s.findMessage(A, 'x'), null)
  s.close()
})

test('saving a copy of a message whose chat was merged meanwhile does not bring the old chat back', () => {
  const s = open()
  s.addMessage(msg({ id: 'x', jid: LID, text: 'on lid' }))
  const held = s.getMessage(LID, 'x')
  s.link(LID, A)
  held.text = 'edited late'
  assert.equal(s.saveMessage(held), false)
  assert.equal(s.q1('SELECT COUNT(*) AS n FROM msg WHERE jid = ?', LID).n, 0)
  assert.equal(s.findMessage(A, 'x').text, 'on lid')
  s.close()
})

test('read-device queries: unreadAfter, receiptBatch, markReceipts, orderIds', () => {
  const s = open()
  const t = now() - 20
  s.addMessage(msg({ id: 'in1', ts: t }))
  s.addMessage(msg({ id: 'out1', ts: t + 1, fromMe: true }))
  s.addMessage(msg({ id: 'in2', ts: t + 2 }))
  s.addMessage(msg({ id: 'in3', ts: t + 3 }))
  s.addMessage(msg({ id: 'out2', ts: t + 4, fromMe: true }))
  assert.equal(s.unreadAfter(A, ['in1']), 2 + 0) // in2, in3 (own messages don't count)
  assert.equal(s.unreadAfter(A, ['in1', 'in3']), 0) // the latest of them decides
  assert.equal(s.unreadAfter(A, ['nope']), -1)
  assert.deepEqual(ids(s.receiptBatch(A, 10)), ['in1', 'in2', 'in3']) // oldest first
  assert.deepEqual(ids(s.receiptBatch(A, 2)), ['in2', 'in3']) // the newest two
  s.markReceipts(A, ['in1', 'in2'])
  assert.deepEqual(ids(s.receiptBatch(A, 10)), ['in3'])
  assert.equal(s.findMessage(A, 'in1').rs, 1)
  assert.deepEqual(s.orderIds(A, ['out2', 'in1', 'missing', 'in3']), ['in1', 'in3', 'out2'])
  s.close()
})

test('chatMedia: newest first, deleted skipped, 300 at most, and it can be asked again', () => {
  const s = open()
  const t = now() - 1000
  for (let i = 0; i < 350; i++) s.addMessage(msg({ id: `img${i}`, ts: t + i, type: 'image', text: '', rm: { x: i } }))
  for (let i = 0; i < 5; i++) s.addMessage(msg({ id: `doc${i}`, ts: t + 400 + i, type: 'document', fileName: `f${i}.pdf`, text: '', rm: { x: i } }))
  s.addMessage(msg({ id: 'vid', ts: t + 500, type: 'video', text: 'see https://example.com/a, and (https://example.org/b).', rm: { x: 1 } }))
  s.addMessage(msg({ id: 'plain', ts: t + 501, text: 'no media here' }))
  s.addMessage(msg({ id: 'gone', ts: t + 502, type: 'image', text: '', rm: { x: 1 } }))
  s.markDeleted(A, 'gone')
  const r = s.chatMedia(A)
  assert.equal(r.media.length, 300)
  assert.deepEqual(r.media[0], { id: 'vid', type: 'video', ts: t + 500 })
  assert.equal(r.media[1].id, 'img349')
  assert.deepEqual(r.docs.map((d) => d.fileName), ['f4.pdf', 'f3.pdf', 'f2.pdf', 'f1.pdf', 'f0.pdf'])
  assert.deepEqual(r.links.map((l) => l.url), ['https://example.com/a', 'https://example.org/b'])
  assert.deepEqual(s.chatMedia(A), r) // the statement can be used again
  assert.deepEqual(s.chatMedia('nobody@s.whatsapp.net'), { media: [], docs: [], links: [] })
  s.close()
})

test('a message that turns up after the replies to it still learns who wrote it', () => {
  const s = open()
  const t = now() - 10
  s.addMessage(msg({ id: 'r', jid: G, ts: t + 1, sender: B, text: 'reply', quote: { id: 'orig', sender: A, fromMe: false } }))
  s.addMessage(msg({ id: 'orig', jid: G, ts: t, sender: undefined, text: 'the original' }))
  assert.equal(s.findMessage(G, 'orig').sender, A)
  s.close()
})

test('hidden ids still to resolve are forgotten when their messages age out', () => {
  const s = open()
  s.addMessage(msg({ id: 'old', jid: G, ts: historyCutoff() - 100, sender: '777@lid' }))
  s.addMessage(msg({ id: 'new', jid: G, ts: now(), sender: '888@lid' }))
  assert.deepEqual(s.pendingLids().sort(), ['777@lid', '888@lid'])
  s.prune()
  assert.deepEqual(s.pendingLids(), ['888@lid'])
  s.close()
})

test('old messages are cleared when the account is opened', () => {
  const d = dir()
  const s = open(d)
  s.addMessage(msg({ id: 'old', ts: historyCutoff() - 100 }))
  s.addMessage(msg({ id: 'new' }))
  s.close()
  const r = open(d)
  assert.deepEqual(ids(r.allMessages(A)), ['new'])
  r.close()
})

test('plenty of messages: 20,000 in one chat, paging still right', () => {
  const s = open()
  const t = now() - 30000
  for (let i = 0; i < 20000; i++) s.addMessage(msg({ id: `m${i}`, ts: t + i }))
  assert.equal(s.count(), 20000)
  assert.deepEqual(ids(s.messageList(A, null, { limit: '2' })), ['m19998', 'm19999'])
  assert.deepEqual(ids(s.messageList(A, null, { beforeId: 'm10000', limit: '2' })), ['m9998', 'm9999'])
  assert.equal(s.messageList(A, null, { sinceId: 'm19990', limit: '1' }).length, 10)
  s.close()
})

// ------------------------------------------------------------------ backup
function untar(buf) {
  const files = {}
  let off = 0
  while (off + 512 <= buf.length) {
    const head = buf.subarray(off, off + 512)
    if (head.every((b) => b === 0)) break
    let name = head.subarray(0, 100).toString('utf8').replace(/\0.*$/, '')
    const size = parseInt(head.subarray(124, 136).toString('ascii').replace(/\0.*$/, '').trim(), 8)
    const type = String.fromCharCode(head[156])
    off += 512
    const body = buf.subarray(off, off + size)
    off += Math.ceil(size / 512) * 512
    if (type === 'L') { files.__long = body.toString('utf8').replace(/\0.*$/, ''); continue }
    if (files.__long) { name = files.__long; delete files.__long }
    files[name] = body
  }
  return files
}
async function backupOf(root) {
  const out = new PassThrough()
  const chunks = []
  out.on('data', (c) => chunks.push(c))
  const done = new Promise((r) => out.on('end', r))
  const result = await streamBackup(root, out)
  await done
  return { result, files: untar(zlib.gunzipSync(Buffer.concat(chunks))) }
}

test('backup: each message database goes in as a consistent copy, without its side files; big files stream through intact', async () => {
  const root = dir()
  const acct = path.join(root, 'accounts', 'anna-1234')
  fs.mkdirSync(acct, { recursive: true })
  const s = new Store(path.join(acct, 'store.json'))
  for (let i = 0; i < 300; i++) s.addMessage(msg({ id: `m${i}`, ts: now() - 300 + i, text: `message ${i}` }))
  s.flush() // what is committed is what the backup sees
  s.addMessage(msg({ id: 'not-yet', text: 'still pending' })) // a write in progress must not tear the copy
  fs.mkdirSync(path.join(root, 'todo'))
  fs.writeFileSync(path.join(root, 'todo', 'small.json'), '{"a":1}')
  const big = Buffer.alloc(9 * 1048576 + 123)
  for (let i = 0; i + 4 <= big.length; i += 4) big.writeUInt32LE((i * 2654435761) >>> 0, i)
  fs.writeFileSync(path.join(root, 'big.bin'), big)
  fs.writeFileSync(path.join(root, 'ignored.tmp'), 'x')
  fs.writeFileSync(path.join(acct, 'store.json.migrated'), 'old copy')

  const { result, files } = await backupOf(root)
  assert.ok(result.files >= 4)
  const names = Object.keys(files).sort()
  assert.ok(names.includes('data/accounts/anna-1234/messages.db'))
  assert.ok(names.includes('data/accounts/anna-1234/chat-meta.json') || !fs.existsSync(path.join(acct, 'chat-meta.json')))
  assert.ok(!names.some((n) => /-wal$|-shm$|\.tmp$|\.migrated$/.test(n)), names.join(', '))
  assert.deepEqual(files['data/todo/small.json'], Buffer.from('{"a":1}'))
  assert.ok(files['data/big.bin'].equals(big))

  // the copy opens as a database of its own and holds exactly what was saved
  const copy = path.join(root, 'restored.db')
  fs.writeFileSync(copy, files['data/accounts/anna-1234/messages.db'])
  const db = new DatabaseSync(copy)
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM msg').get().n, 300)
  assert.equal(db.prepare('PRAGMA integrity_check').get().integrity_check, 'ok')
  db.close()
  // and the live one was not disturbed
  s.flush()
  assert.equal(s.count(), 301)
  s.close()
})

test('backup: a failed SQLite snapshot aborts the archive instead of omitting messages', async () => {
  const root = dir()
  fs.writeFileSync(path.join(root, 'messages.db'), 'not a database')
  const out = new PassThrough()
  out.resume()
  await assert.rejects(streamBackup(root, out), /Could not back up .*messages\.db/)
  assert.equal(out.writableFinished, false)
})
