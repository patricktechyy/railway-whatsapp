import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Store, bare, toPn, looksLikePhone, plainPreview, previewOf, historyCutoff } from '../store.js'

// These pin down what the chat Store does today, so the SQLite version has to behave the same.

const A = '6581111111@s.whatsapp.net'
const B = '6582222222@s.whatsapp.net'
const LID = '12345678901@lid'
const G = '120363000000000001@g.us'
const now = () => Math.floor(Date.now() / 1000)

const made = []
function tmp() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-store-'))
  made.push(d)
  return d
}
test.after(() => {
  for (const d of made) {
    try { fs.rmSync(d, { recursive: true, force: true }) } catch {} // (Windows keeps a folder while a database in it is open)
  }
})

function mk() {
  const dir = tmp()
  return new Store(path.join(dir, 'store.json'))
}
const msg = (o) => ({ id: 'm1', jid: A, fromMe: false, ts: now(), type: 'text', text: 'hi', ...o })
const ids = (list) => list.map((m) => m.id)
function fill(s, jid, n, t0 = now() - n) {
  for (let i = 0; i < n; i++) s.addMessage(msg({ id: `m${i}`, jid, ts: t0 + i, text: `t${i}` }))
}

test('helpers', () => {
  assert.equal(bare('123:4@s.whatsapp.net'), '123@s.whatsapp.net')
  assert.equal(toPn('+65 8111 1111'), A)
  assert.equal(toPn('123:4@s.whatsapp.net'), '123@s.whatsapp.net')
  assert.equal(toPn('hello'), null)
  assert.equal(toPn('12@lid'), null)
  assert.ok(looksLikePhone('+65 8111 1111'))
  assert.ok(looksLikePhone('+65••••••46'))
  assert.ok(!looksLikePhone('Budi'))
  assert.equal(plainPreview('*bold* and _it_\nnext ~gone~'), 'bold and it next gone')
})

test('addMessage: new message creates the chat, preview and unread', () => {
  const s = mk()
  const t = now()
  const out = s.addMessage(msg({ ts: t, text: 'hello' }), { bumpUnread: true })
  assert.equal(out.id, 'm1')
  const c = s.chats.get(A)
  assert.deepEqual({ t: c.t, unread: c.unread, preview: c.preview }, { t, unread: 1, preview: 'hello' })
  s.addMessage(msg({ ts: t, text: 'hello' }), { bumpUnread: true }) // the same message again is not new
  assert.equal(s.chats.get(A).unread, 1)
  assert.equal(s.allMessages(A).length, 1)
  s.close()
})

test('addMessage: own messages never count as unread; previews say You:', () => {
  const s = mk()
  s.addMessage(msg({ fromMe: true, text: 'mine' }), { bumpUnread: true })
  assert.equal(s.chats.get(A).unread, 0)
  assert.equal(s.chats.get(A).preview, 'You: mine')
  s.close()
})

test('addMessage: out-of-order arrival is sorted, ties keep arrival order, preview stays on the newest', () => {
  const s = mk()
  const t = now()
  s.addMessage(msg({ id: 'late', ts: t + 10, text: 'late' }))
  s.addMessage(msg({ id: 'early', ts: t + 5, text: 'early' }))
  s.addMessage(msg({ id: 'tie1', ts: t + 5, text: 'tie1' }))
  s.addMessage(msg({ id: 'tie2', ts: t + 5, text: 'tie2' }))
  assert.deepEqual(ids(s.allMessages(A)), ['early', 'tie1', 'tie2', 'late'])
  assert.equal(s.chats.get(A).preview, 'late')
  assert.equal(s.chats.get(A).t, t + 10)
  s.close()
})

test('addMessage: a re-sent copy never wipes known fields; returns the input, not the merged row', () => {
  const s = mk()
  const first = msg({ id: 'g1', jid: G, sender: A, text: 'x', quote: { id: 'q', text: 'old' } })
  s.addMessage(first)
  const resent = { id: 'g1', jid: G, fromMe: false, ts: first.ts, type: 'text', text: 'x', sender: undefined, quote: undefined }
  const out = s.addMessage(resent)
  assert.equal(out, resent)
  const stored = s.findMessage(G, 'g1')
  assert.equal(stored.sender, A)
  assert.equal(stored.quote.id, 'q')
  s.close()
})

test('addMessage: ids deleted for me never come back', () => {
  const s = mk()
  s.addMessage(msg({ id: 'x' }))
  s.removeMessage(A, 'x')
  assert.equal(s.addMessage(msg({ id: 'x' })), null)
  assert.equal(s.findMessage(A, 'x'), null)
  s.close()
})

test('deleted and edited messages stay that way when WhatsApp re-syncs the original', () => {
  const s = mk()
  s.addMessage(msg({ id: 'd', text: 'secret', rm: { a: 1 }, quote: { id: 'q' } }))
  s.markDeleted(A, 'd')
  assert.equal(s.chats.get(A).preview, '🚫 This message was deleted')
  s.addMessage(msg({ id: 'd', text: 'secret' }))
  const d = s.findMessage(A, 'd')
  assert.equal(d.deleted, true)
  assert.equal(d.text, '')
  assert.equal(d.rm, undefined)
  // (today a re-sync also puts the old text back into the chat-list preview; that is a bug, not pinned here)

  s.addMessage(msg({ id: 'e', text: 'first' }))
  s.markEdited(A, 'e', 'second')
  s.addMessage(msg({ id: 'e', text: 'first' }))
  const e = s.findMessage(A, 'e')
  assert.equal(e.text, 'second')
  assert.equal(e.edited, true)
  s.close()
})

test('a waiting placeholder replaced by the real message counts as new', () => {
  const s = mk()
  s.addMessage(msg({ id: 'w', type: 'waiting', waiting: true, text: 'Waiting…' }), { bumpUnread: true })
  assert.equal(s.chats.get(A).unread, 1)
  s.addMessage(msg({ id: 'w', text: 'real' }), { bumpUnread: true })
  assert.equal(s.chats.get(A).unread, 2)
  assert.equal(s.findMessage(A, 'w').waiting, undefined)
  s.close()
})

test('removeMessage: gone for good, preview falls back to the new last message', () => {
  const s = mk()
  const t = now()
  s.addMessage(msg({ id: 'a', ts: t, text: 'one' }))
  s.addMessage(msg({ id: 'b', ts: t + 1, text: 'two' }))
  assert.equal(s.removeMessage(A, 'b'), true)
  assert.equal(s.removeMessage(A, 'nope'), false)
  assert.equal(s.chats.get(A).preview, 'one')
  assert.ok(s.gone.has('b') && s.gone.has('nope'))
  s.close()
})

test('messageList: newest n, pages before an id, inclusive since an id', () => {
  const s = mk()
  fill(s, A, 10)
  const L = (q) => ids(s.messageList(A, null, q))
  assert.deepEqual(L({}), ['m0', 'm1', 'm2', 'm3', 'm4', 'm5', 'm6', 'm7', 'm8', 'm9'])
  assert.deepEqual(L({ limit: '3' }), ['m7', 'm8', 'm9'])
  assert.deepEqual(L({ beforeId: 'm5', limit: '2' }), ['m3', 'm4'])
  assert.deepEqual(L({ beforeId: 'm2', limit: '5' }), ['m0', 'm1'])
  assert.deepEqual(L({ beforeId: 'm0', limit: '5' }), [])
  assert.deepEqual(L({ beforeId: 'unknown', limit: '5' }), [])
  assert.deepEqual(L({ sinceId: 'm7', limit: '1' }), ['m7', 'm8', 'm9']) // inclusive, not capped by limit
  assert.deepEqual(L({ sinceId: 'unknown', limit: '2' }), ['m8', 'm9']) // unknown: the newest n
  assert.deepEqual(L({ sinceId: 'm8', beforeId: 'm2', limit: '5' }), ['m8', 'm9']) // since wins over before
  assert.equal(L({ limit: '0' }).length, 10) // "0" means the default 200
  assert.equal(L({ limit: null, beforeId: null, sinceId: null }).length, 10)
  s.close()
})

test('messageList: limit is capped at 5000, default page is 200', () => {
  const s = mk()
  fill(s, A, 5100, now() - 6000)
  assert.equal(s.messageList(A, null, { limit: '99999' }).length, 5000)
  assert.equal(s.messageList(A, null, { limit: 'abc' }).length, 200)
  assert.equal(s.messageList(A, null, { sinceId: 'unknown' }).length, 200)
  s.close()
})

test('messageList: the shape the page reads', () => {
  const s = mk()
  s.addMessage(msg({ id: 'p', fromMe: true, rm: { x: 1 }, text: 'photo', type: 'image' }))
  s.addMessage(msg({ id: 'g', jid: G, sender: A, text: 'in group' }))
  s.addMessage(msg({ id: 'h', jid: G, fromMe: true, ts: now() + 1, text: 'mine in group' }))
  s.setContact(A, { notify: 'Budi' })
  const [p] = s.messageList(A, null, {})
  assert.equal(p.media, true)
  assert.equal(p.status, 2)
  assert.equal(p.senderName, '')
  assert.equal(p.deleted, false)
  assert.deepEqual(p.reactions, [])
  const g = s.messageList(G, null, {})
  assert.equal(g[0].senderName, 'Budi')
  assert.equal(g[0].sender, A)
  assert.equal(g[1].sender, undefined)
  assert.equal(g[1].senderName, '')
  s.close()
})

test('LID to phone merge: messages move over, duplicates keep the phone copy, rj remembers the old address', () => {
  const s = mk()
  const t = now()
  s.addMessage(msg({ id: 'x', jid: LID, ts: t, text: 'from lid' }), { bumpUnread: true })
  s.addMessage(msg({ id: 'y', jid: LID, ts: t + 2, text: 'lid copy' }), { bumpUnread: true })
  s.addMessage(msg({ id: 'y', jid: A, ts: t + 2, text: 'pn copy' }), { bumpUnread: true })
  s.addMessage(msg({ id: 'z', jid: A, ts: t + 1, text: 'pn only' }), { bumpUnread: true })
  s.setLocked(LID, true)
  s.setContact(LID, { notify: 'Lida' })
  assert.equal(s.link(LID, A), true)
  assert.equal(s.link(LID, A), false) // nothing new
  assert.deepEqual(ids(s.allMessages(A)), ['x', 'z', 'y'])
  assert.equal(s.findMessage(A, 'y').text, 'pn copy')
  assert.equal(s.findMessage(A, 'x').jid, A)
  assert.equal(s.findMessage(A, 'x').rj, LID)
  assert.equal(s.q1('SELECT COUNT(*) AS n FROM msg WHERE jid = ?', LID).n, 0)
  assert.equal(s.chats.has(LID), false)
  assert.equal(s.chats.get(A).unread, 4)
  assert.ok(s.isLocked(A) && !s.locked.has(LID))
  assert.equal(s.contacts.get(A).notify, 'Lida')
  assert.equal(s.findMessage(LID, 'x').id, 'x') // the old address still finds the chat
  s.close()
})

test('link keeps an earlier rj and the newest preview', () => {
  const s = mk()
  const t = now()
  s.addMessage(msg({ id: 'a', jid: LID, ts: t + 5, text: 'newest on lid', rj: 'old@lid' }))
  s.addMessage(msg({ id: 'b', jid: A, ts: t, text: 'older on pn' }))
  s.link(LID, A)
  assert.equal(s.findMessage(A, 'a').rj, 'old@lid')
  assert.equal(s.chats.get(A).preview, 'newest on lid')
  assert.equal(s.chats.get(A).t, t + 5)
  s.close()
})

test('replies fill in a group message sender, and can reveal who a LID is', () => {
  const s = mk()
  const t = now()
  s.addMessage(msg({ id: 'orig', jid: G, ts: t, sender: undefined, text: 'no sender yet' }))
  s.addMessage(msg({ id: 'r1', jid: G, ts: t + 1, sender: B, text: 'reply', quote: { id: 'orig', sender: A, fromMe: false, text: 'x' } }))
  assert.equal(s.findMessage(G, 'orig').sender, A)

  s.addMessage(msg({ id: 'orig2', jid: G, ts: t + 2, sender: LID, text: 'by lid' }))
  s.addMessage(msg({ id: 'r2', jid: G, ts: t + 3, sender: B, text: 'reply 2', quote: { id: 'orig2', sender: A, fromMe: false, text: 'x' } }))
  assert.equal(s.alias.get(LID), A)
  s.close()
})

test('pendingLids: every LID without a number, wherever it turns up', () => {
  const s = mk()
  const L2 = '222@lid'
  const L3 = '333@lid'
  const L4 = '444@lid'
  s.addMessage(msg({ id: '1', jid: L2, text: 'chat' }))
  s.setContact(L3, { notify: 'Three' })
  s.addMessage(msg({ id: '2', jid: G, sender: L4, text: 'in group' }))
  assert.deepEqual(s.pendingLids().sort(), [L2, L3, L4].sort())
  s.link(L2, A)
  assert.deepEqual(s.pendingLids().sort(), [L3, L4].sort())
  s.close()
})

test('setReaction / reactionView', () => {
  const s = mk()
  s.addMessage(msg({ id: 'r' }))
  s.setReaction(A, 'r', A, '👍')
  s.setReaction(A, 'r', B, '👍')
  s.setReaction(A, 'r', 'c@s.whatsapp.net', '❤️')
  let v = s.reactionView(s.findMessage(A, 'r'), B)
  assert.deepEqual(v.find((x) => x.emoji === '👍'), { emoji: '👍', count: 2, mine: true })
  assert.deepEqual(v.find((x) => x.emoji === '❤️'), { emoji: '❤️', count: 1, mine: false })
  s.setReaction(A, 'r', A, '😂') // replaces theirs
  s.setReaction(A, 'r', B, '') // removes
  v = s.reactionView(s.findMessage(A, 'r'), B)
  assert.deepEqual(v.map((x) => x.emoji).sort(), ['❤️', '😂'].sort())
  assert.equal(s.setReaction(A, 'missing', A, '👍'), null)
  s.close()
})

test('message history is kept only when switched on, and only the last 20 versions', () => {
  const s = mk()
  s.addMessage(msg({ id: 'h', text: 'v0' }))
  s.markEdited(A, 'h', 'v1')
  assert.equal(s.historyOf(A, 'h'), null)
  s.histOn = () => true
  s.markEdited(A, 'h', 'v2')
  s.markEdited(A, 'h', 'v2') // unchanged text: no new version
  s.markDeleted(A, 'h')
  s.markDeleted(A, 'h') // already deleted: nothing more
  const h = s.historyOf(A, 'h')
  assert.deepEqual(h.versions.map((v) => [v.kind, v.text]), [['edit', 'v1'], ['deleted', 'v2']])
  assert.equal(h.now.deleted, true)
  s.addMessage(msg({ id: 'many', text: 'a' }))
  for (let k = 0; k < 25; k++) s.markEdited(A, 'many', `e${k}`)
  assert.equal(s.findMessage(A, 'many').hist.length, 20)
  s.close()
})

test('chatList: newest first, empty chats hidden, locked chats separate', () => {
  const s = mk()
  const t = now()
  s.addMessage(msg({ id: '1', jid: A, ts: t, text: 'old' }))
  s.addMessage(msg({ id: '2', jid: B, ts: t + 5, text: 'new' }))
  s.addMessage(msg({ id: '3', jid: G, ts: t + 3, text: '*bold*\nline' }))
  s.setGroup(G, 'Team')
  s.setGroup('999@g.us', 'Empty') // no messages: t is 0
  s.touchChat(B, { localPinned: true, localMute: -1 })
  const list = s.chatList()
  assert.deepEqual(list.map((c) => c.jid), [B, G, A])
  assert.equal(list[1].name, 'Team')
  assert.equal(list[1].preview, 'bold line')
  assert.equal(list[1].group, true)
  assert.equal(list[0].pinned, true)
  assert.equal(list[0].muted, -1)
  assert.equal(list[2].muted, undefined)
  s.setLocked(A, true)
  assert.deepEqual(s.chatList().map((c) => c.jid), [B, G])
  assert.deepEqual(s.chatList({ lockedOnly: true }).map((c) => [c.jid, c.locked]), [[A, true]])
  s.close()
})

test('names: nickname beats everything, phone-looking names are ignored', () => {
  const s = mk()
  assert.equal(s.displayName(A), '+6581111111')
  assert.equal(s.displayName(LID), 'Unknown contact')
  s.setContact(A, { notify: 'Notify', verified: '+65 8111 1111' })
  assert.equal(s.displayName(A), 'Notify')
  s.setContact(A, { verified: 'Shop' })
  assert.equal(s.displayName(A), 'Shop')
  s.setContact(A, { name: 'Saved' })
  assert.equal(s.displayName(A), 'Saved')
  assert.equal(s.profileName(A), 'Notify')
  s.setNick(A, '  Bestie ')
  assert.equal(s.displayName(A), 'Bestie')
  s.setNick(A, '')
  assert.equal(s.displayName(A), 'Saved')
  assert.equal(s.displayName(G), 'Group')
  s.setGroup(G, 'Team')
  assert.equal(s.displayName(G), 'Team')
  s.close()
})

test('contactList: search by name or digits, locked hidden unless allowed, newest chats first', () => {
  const s = mk()
  const t = now()
  s.setContact(A, { name: 'Anna' })
  s.setContact(B, { name: 'Bob' })
  s.addMessage(msg({ id: '1', jid: B, ts: t, text: 'x' }))
  s.addMessage(msg({ id: '2', jid: 'status@broadcast', ts: t, text: 'x' }))
  assert.deepEqual(s.contactList('').map((c) => c.name), ['Bob', 'Anna'])
  assert.deepEqual(s.contactList('ann').map((c) => c.name), ['Anna'])
  assert.deepEqual(s.contactList('2222').map((c) => c.name), ['Bob'])
  s.setLocked(B, true)
  assert.deepEqual(s.contactList('').map((c) => c.name), ['Anna'])
  assert.deepEqual(s.contactList('', 60, { withLocked: true }).map((c) => c.name), ['Bob', 'Anna'])
  s.close()
})

test('mutedUntil: always, until a time, expired, and the larger of site and phone', () => {
  const s = mk()
  s.addMessage(msg({ id: '1' }))
  const nowMs = Date.now()
  assert.equal(s.mutedUntil(A), 0)
  s.touchChat(A, { localMute: nowMs + 1000 })
  assert.equal(s.mutedUntil(A, nowMs), nowMs + 1000)
  s.touchChat(A, { waMute: nowMs + 5000 })
  assert.equal(s.mutedUntil(A, nowMs), nowMs + 5000)
  assert.equal(s.mutedUntil(A, nowMs + 9000), 0)
  s.touchChat(A, { waMute: -1 })
  assert.equal(s.mutedUntil(A, nowMs + 9000), -1)
  s.touchChat(A, { localMute: 0, waMute: 0 })
  assert.equal(s.mutedUntil(A), 0)
  s.close()
})

test('markRead, and touchChat only ever moves t forward', () => {
  const s = mk()
  const t = now()
  s.addMessage(msg({ id: '1', ts: t }), { bumpUnread: true })
  s.markRead(A)
  assert.equal(s.chats.get(A).unread, 0)
  s.touchChat(A, { t: t - 100 })
  assert.equal(s.chats.get(A).t, t)
  s.touchChat(A, { t: t + 100 })
  assert.equal(s.chats.get(A).t, t + 100)
  s.close()
})

test('oldest, findMessage and previewOf', () => {
  const s = mk()
  const t = now()
  s.addMessage(msg({ id: 'a', ts: t }))
  s.addMessage(msg({ id: 'b', ts: t + 1 }))
  assert.equal(s.oldest(A).id, 'a')
  assert.equal(s.oldest('nobody@s.whatsapp.net'), null)
  assert.equal(s.findMessage('nobody@s.whatsapp.net', 'a'), null)
  assert.equal(previewOf({ type: 'image', jid: A, text: '' }, s), '📷 Photo')
  assert.equal(previewOf({ type: 'document', jid: A, text: 'cap', fileName: 'x.pdf' }, s), '📄 x.pdf')
  assert.equal(previewOf({ type: 'poll', jid: A, text: 'Q' }, s), '📊 Q')
  assert.equal(previewOf({ type: 'text', jid: A, text: 'hi @65822', mentions: [{ t: '65822', j: B }] }, s), 'hi @+6582222222')
  s.close()
})

test('flush writes a snapshot a new Store reads back: chats, contacts, aliases, gone, locks, messages', () => {
  const dir = tmp()
  const file = path.join(dir, 'sub', 'store.json')
  const s = new Store(file)
  const t = now()
  s.addMessage(msg({ id: 'a', ts: t, text: 'kept', rm: { message: { imageMessage: { mediaKey: { $b: 'AA==' } } } } }))
  s.addMessage(msg({ id: 'b', jid: G, ts: t, sender: B, text: 'in group' }))
  s.setContact(A, { name: 'Anna' })
  s.link(LID, B)
  s.setLocked(A, true)
  s.removeMessage(A, 'gone-id')
  s.touchChat(A, { localPinned: true })
  s.flush()
  assert.equal(s.dirty, false)
  const rmBefore = s.findMessage(A, 'a').rm
  s.close()

  const r = new Store(file)
  assert.equal(r.chats.get(A).preview, 'kept')
  assert.equal(r.chats.get(A).localPinned, true)
  assert.equal(r.contacts.get(A).name, 'Anna')
  assert.equal(r.alias.get(LID), B)
  assert.ok(r.gone.has('gone-id'))
  assert.ok(r.isLocked(A))
  assert.equal(r.findMessage(A, 'a').text, 'kept')
  assert.deepEqual(r.findMessage(A, 'a').rm, rmBefore)
  assert.equal(r.findMessage(G, 'b').sender, B)
  r.close()
  // chats and contacts in one small file, messages in the database; no temp files left behind
  assert.deepEqual(fs.readdirSync(path.dirname(file)).filter((f) => !f.startsWith('messages.db-')).sort(), ['chat-meta.json', 'messages.db'])
})

test('prune: messages past the history window are dropped; the chat itself stays', () => {
  const s = mk()
  s.addMessage(msg({ id: 'old', ts: historyCutoff() - 3600, text: 'old' }))
  s.addMessage(msg({ id: 'new', ts: now(), text: 'new' }))
  assert.equal(s.prune(), 1)
  assert.deepEqual(ids(s.allMessages(A)), ['new'])
  assert.equal(s.count(), 1)
  assert.equal(s.chats.get(A).preview, 'new')
  assert.equal(s.prune(), 0)
  s.close()
})

test('flush: the small file is only written when something changed; gone is trimmed to the last 3000', () => {
  const dir = tmp()
  const file = path.join(dir, 'store.json')
  const s = new Store(file)
  s.flush()
  assert.equal(fs.existsSync(s.metaFile), false)
  s.addMessage(msg({ id: 'a' }))
  for (let i = 0; i < 3005; i++) s.removeMessage(A, `gone${i}`)
  s.flush()
  const disk = JSON.parse(fs.readFileSync(s.metaFile, 'utf8'))
  assert.equal(disk.gone.length, 3000)
  assert.equal(disk.gone.at(-1), 'gone3004')
  assert.equal(disk.gone[0], 'gone5')
  s.close()
})

test('load: older snapshots with plain-string contacts and phone-like names', () => {
  const dir = tmp()
  const file = path.join(dir, 'store.json')
  fs.writeFileSync(file, JSON.stringify({
    chats: [{ jid: A, t: 5, unread: 0, preview: 'p' }],
    contacts: [[A, 'Old Name'], [B, { name: '+65 8222 2222', notify: 'Bob' }]],
    messages: { [A]: [{ id: 'a', jid: A, ts: now(), type: 'text', text: 'x' }] },
  }))
  const s = new Store(file)
  assert.equal(s.displayName(A), 'Old Name')
  assert.equal(s.displayName(B), 'Bob')
  assert.equal(s.contacts.get(B).name, undefined)
  s.close()
})

test('load: an unreadable snapshot starts empty instead of crashing', () => {
  const dir = tmp()
  const file = path.join(dir, 'store.json')
  fs.writeFileSync(file, '{ not json')
  const s = new Store(file)
  assert.equal(s.chats.size, 0)
  s.close()
})

test('load: group replies stored before their original still fill in senders', () => {
  const dir = tmp()
  const file = path.join(dir, 'store.json')
  const t = now()
  fs.writeFileSync(file, JSON.stringify({
    messages: {
      [G]: [
        { id: 'o', jid: G, ts: t, type: 'text', text: 'orig' },
        { id: 'r', jid: G, ts: t + 1, type: 'text', text: 'reply', sender: B, quote: { id: 'o', sender: A } },
      ],
    },
  }))
  const s = new Store(file)
  assert.equal(s.findMessage(G, 'o').sender, A)
  s.close()
})

test('chat-list previews are cut to one short line, never in the middle of an emoji', () => {
  const s = mk()
  const long = 'a'.repeat(299) + '😀' + 'b'.repeat(500)
  s.addMessage(msg({ id: 'long', text: long }))
  const p = s.chats.get(A).preview
  assert.ok(p.length <= 300)
  assert.ok(p.startsWith('aaaa'))
  assert.ok(!/[\ud800-\udbff]$/.test(p))
  assert.equal(s.chatList()[0].preview, p)
  // the message itself is untouched
  assert.equal(s.findMessage(A, 'long').text, long)
  // a short one is left alone, and so is refreshPreview after a delete
  s.addMessage(msg({ id: 'short', ts: now() + 5, text: 'short one' }))
  assert.equal(s.chats.get(A).preview, 'short one')
  s.removeMessage(A, 'short')
  assert.ok(s.chats.get(A).preview.length <= 300)
  s.close()
})

test('load: previews already stored long are cut when the snapshot is read', () => {
  const dir = tmp()
  const file = path.join(dir, 'store.json')
  fs.writeFileSync(file, JSON.stringify({ chats: [{ jid: A, t: 5, unread: 0, preview: 'x'.repeat(5000) }] }))
  const s = new Store(file)
  assert.equal(s.chats.get(A).preview.length, 300)
  s.close()
})
