import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { register } from 'node:module'

// session.js with a pretend WhatsApp socket: real incoming messages go in, and everything that reads or
// changes stored messages is exercised. (Only the "qrcode" import is replaced; no network is used.)
register('./fixtures/stub-hooks.mjs', import.meta.url)
const { Session } = await import('../session.js')

const ME = '6580000009@s.whatsapp.net'
const A = '6581111111@s.whatsapp.net'
const B = '6582222222@s.whatsapp.net'
const C = '6583333333@s.whatsapp.net'
const G = '120363000000000001@g.us'
const now = () => Math.floor(Date.now() / 1000)
const made = []

function account() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-sess-'))
  made.push(dir)
  const s = new Session({ key: 'anna', label: 'Anna', dir })
  s.me = { jid: ME, lid: null, phone: '+6580000009', name: 'Anna' }
  s.status = 'connected'
  const sent = []
  const reads = []
  let n = 0
  s.sock = {
    readMessages: async (keys) => { reads.push(...keys) },
    sendPresenceUpdate: async () => {},
    relayMessage: async (to, message, opts) => { sent.push({ relay: message, to, opts }) },
    sendMessage: async (to, content) => {
      sent.push({ to, content })
      const id = `OUT${++n}`
      const key = { remoteJid: to, id, fromMe: true }
      if (content.poll) {
        // like Baileys' answer: no messageSecret in it, so the session has to keep its own
        return { key, messageTimestamp: now(), message: { pollCreationMessageV3: { name: content.poll.name, options: content.poll.values.map((optionName) => ({ optionName })), selectableOptionsCount: content.poll.selectableCount } } }
      }
      if (content.delete || content.edit || content.react) return { key, messageTimestamp: now(), message: {} }
      return { key, messageTimestamp: now(), message: { conversation: content.text } }
    },
  }
  return { s, dir, sent, reads }
}
test.after(() => {
  for (const d of made) {
    try { fs.rmSync(d, { recursive: true, force: true }) } catch {}
  }
})

const incoming = (id, jid, body, o = {}) => ({
  key: { remoteJid: jid, id, fromMe: false, ...(o.key || {}) },
  message: o.message || { conversation: body },
  messageTimestamp: o.ts ?? now(),
  pushName: o.pushName,
})
const feed = (s, messages, type = 'notify') => s.onUpsert({ messages, type }, s.sock, () => true)
const ids = (list) => list.map((m) => m.id)

test('incoming messages are stored, counted as unread, and announced to open pages', () => {
  const { s } = account()
  const events = []
  s.on('event', (e) => events.push(e))
  const t = now() - 10
  const r = feed(s, [incoming('1', A, 'hello', { ts: t, pushName: 'Anna B' }), incoming('2', A, 'again', { ts: t + 1 })])
  assert.equal(r.received, 2)
  assert.deepEqual(ids(s.store.messageList(A, ME, {})), ['1', '2'])
  assert.equal(s.store.chats.get(A).unread, 2)
  assert.equal(s.store.displayName(A), 'Anna B')
  assert.equal(events.filter((e) => e.type === 'message').length, 2)
  assert.equal(s.health().store.messages, 2)
  assert.ok(s.health().store.bytes > 0)
  s.shutdown()
})

test('photos keep what is needed to fetch them, and show in the chat media', () => {
  const { s } = account()
  feed(s, [incoming('img', A, '', { message: { imageMessage: { mimetype: 'image/jpeg', caption: 'look', mediaKey: new Uint8Array([1, 2, 3]), directPath: '/x', jpegThumbnail: new Uint8Array(500) } } })])
  const m = s.store.messageList(A, ME, {})[0]
  assert.equal(m.type, 'image')
  assert.equal(m.media, true)
  assert.equal(m.text, 'look')
  const stored = s.store.findMessage(A, 'img')
  assert.deepEqual(stored.rm.message.imageMessage.mediaKey, { $b: 'AQID' })
  assert.equal(stored.rm.message.imageMessage.jpegThumbnail, undefined)
  assert.deepEqual(s.chatMedia(A).media.map((x) => x.id), ['img'])
  s.shutdown()
})

test('group messages: sender, a reply learning who wrote the original, receipts for several people', () => {
  const { s } = account()
  const t = now() - 10
  feed(s, [incoming('g1', G, 'original', { ts: t, key: { participant: A } })])
  feed(s, [incoming('g2', G, '', { ts: t + 1, key: { participant: B }, message: { extendedTextMessage: { text: 'reply', contextInfo: { stanzaId: 'g1', participant: A, quotedMessage: { conversation: 'original' } } } } })])
  const list = s.store.messageList(G, ME, {})
  assert.equal(list[0].sender, A)
  assert.equal(list[1].quote.id, 'g1')
  assert.equal(list[1].quote.text, 'original')

  // our own message in the group, and two people's receipts: ticks go grey -> delivered -> read only when everybody has
  s.groupCache.set(G, { id: G, participants: [{ id: A }, { id: B }, { id: ME }] })
  s.store.addMessage({ id: 'mine', jid: G, fromMe: true, ts: t + 2, type: 'text', text: 'hi all', status: 2 })
  s.recordGroupReceipt(G, s.store.findMessage(G, 'mine'), A, 3)
  assert.equal(s.store.findMessage(G, 'mine').status, 2)
  s.recordGroupReceipt(G, s.store.findMessage(G, 'mine'), B, 3)
  assert.equal(s.store.findMessage(G, 'mine').status, 3)
  s.recordGroupReceipt(G, s.store.findMessage(G, 'mine'), A, 4)
  s.recordGroupReceipt(G, s.store.findMessage(G, 'mine'), B, 4)
  const done = s.store.findMessage(G, 'mine')
  assert.equal(done.status, 4)
  assert.deepEqual(done.rsum, { total: 2, delivered: 2, read: 2 })
  assert.equal(done.rcpt[A], 4)
  s.shutdown()
})

test('markRead sends a receipt for every unacknowledged incoming message, once', async () => {
  const { s, reads } = account()
  const t = now() - 20
  feed(s, [incoming('r1', A, 'one', { ts: t }), incoming('r2', A, 'two', { ts: t + 1 }), incoming('r3', A, 'three', { ts: t + 2 })])
  s.store.addMessage({ id: 'out', jid: A, fromMe: true, ts: t + 3, type: 'text', text: 'mine' })
  await s.markRead(A)
  assert.deepEqual(reads.map((k) => k.id), ['r1', 'r2', 'r3'])
  assert.equal(s.store.chats.get(A).unread, 0)
  await s.markRead(A)
  assert.equal(reads.length, 3) // nothing left to acknowledge
  s.shutdown()
})

test('markRead while disconnected is remembered and goes out on reconnect', async () => {
  const { s, reads } = account()
  feed(s, [incoming('p1', A, 'x')])
  s.status = 'reconnecting'
  await s.markRead(A)
  assert.equal(reads.length, 0)
  assert.ok(s.readPending.has(A))
  s.status = 'connected'
  s.flushReadPending()
  await new Promise((r) => setTimeout(r, 20))
  assert.deepEqual(reads.map((k) => k.id), ['p1'])
  s.shutdown()
})

test('read on another device: the unread badge drops to what really came after', () => {
  const { s } = account()
  const t = now() - 30
  feed(s, ['a', 'b', 'c', 'd'].map((id, i) => incoming(id, A, id, { ts: t + i })))
  assert.equal(s.store.chats.get(A).unread, 4)
  s.readElsewhere(A, ['b'])
  assert.equal(s.store.chats.get(A).unread, 2)
  s.readElsewhere(A, ['a']) // an older one never raises it again
  assert.equal(s.store.chats.get(A).unread, 2)
  s.readElsewhere(A, ['nope'])
  assert.equal(s.store.chats.get(A).unread, 2)
  s.shutdown()
})

test('reactions, edits and deletes from the other side', () => {
  const { s } = account()
  const t = now() - 10
  feed(s, [incoming('x', A, 'original', { ts: t })])
  s.applyReactionEvent({ key: { remoteJid: A, id: 'x' }, reaction: { text: '👍' }, reactorKey: { remoteJid: A, fromMe: false } })
  assert.deepEqual(s.store.messageList(A, ME, {})[0].reactions, [{ emoji: '👍', count: 1, mine: false }])
  s.applyRemoteEdit({ remoteJid: A, id: 'x' }, null, { conversation: 'edited' })
  const m = s.store.messageList(A, ME, {})[0]
  assert.equal(m.text, 'edited')
  assert.equal(m.edited, true)
  s.applyRemoteDelete({ remoteJid: A, id: 'x' }, null)
  const d = s.store.messageList(A, ME, {})[0]
  assert.equal(d.deleted, true)
  assert.equal(d.text, '')
  assert.equal(s.store.chats.get(A).preview, '🚫 This message was deleted')
  s.shutdown()
})

test('sending: edit and delete-for-everyone act on the saved message', async () => {
  const { s, sent } = account()
  const out = await s.send(A, 'first draft')
  assert.equal(out.text, 'first draft')
  const edited = await s.editMessage(A, out.id, 'second draft')
  assert.equal(edited.text, 'second draft')
  assert.equal(s.store.findMessage(A, out.id).edited, true)
  assert.ok(sent.some((x) => x.content?.edit))
  await s.deleteMessage(A, out.id, true)
  assert.equal(s.store.findMessage(A, out.id).deleted, true)
  // delete for me: gone from the list altogether
  const out2 = await s.send(A, 'to remove')
  const r = await s.deleteMessage(A, out2.id, false)
  assert.equal(r.removed, true)
  assert.equal(s.store.findMessage(A, out2.id), null)
  s.shutdown()
})

test('polls: the secret is kept with the saved poll, and votes (ours and theirs) add up', async () => {
  const { s, sent } = account()
  const poll = await s.sendPoll(A, { name: 'Lunch?', options: ['Pizza', 'Sushi'], multi: false })
  const saved = s.store.findMessage(A, poll.id)
  assert.ok(saved.poll.secret, 'the saved poll has its secret')
  assert.equal(poll.poll.canVote, true)

  const voted = await s.votePoll(A, poll.id, [1])
  assert.ok(sent.some((x) => x.relay?.pollUpdateMessage))
  assert.equal(voted.poll.options[1].n, 1)
  assert.equal(voted.poll.options[1].mine, true)
  const afterVote = s.store.messageList(A, ME, {})[0].poll
  assert.equal(afterVote.options[1].n, 1)
  assert.equal(afterVote.voters, 1)

  // somebody else's vote arrives already opened (the way Baileys hands it over)
  const hash = (await import('../poll.js')).optionHash
  s.applyOpenedVote({ remoteJid: A, id: poll.id }, { pollUpdateMessageKey: { remoteJid: A, fromMe: false }, vote: { selectedOptions: [hash('Pizza')] } })
  const both = s.store.messageList(A, ME, {})[0].poll
  assert.equal(both.options[0].n, 1)
  assert.equal(both.options[1].n, 1)
  assert.equal(both.voters, 2)
  s.shutdown()
})

test('an in-flight vote does not publish a poll that was removed while the vote was sending', async () => {
  const { s } = account()
  const poll = await s.sendPoll(A, { name: 'Lunch?', options: ['Pizza', 'Sushi'] })
  const events = []
  s.on('event', (e) => events.push(e))
  s.sock.relayMessage = () => s.deleteMessage(A, poll.id, false)
  assert.equal(await s.votePoll(A, poll.id, [1]), null)
  assert.equal(s.store.findMessage(A, poll.id), null)
  assert.ok(!events.some((e) => e.type === 'message'))
  s.shutdown()
})

test('forwarding sends in the order the messages sit in the chat, whatever order they were picked in', async () => {
  const { s, sent } = account()
  const t = now() - 30
  feed(s, ['f1', 'f2', 'f3'].map((id, i) => incoming(id, A, `text ${id}`, { ts: t + i })))
  const r = await s.forward(A, ['f3', 'f1', 'f2'], [B])
  assert.equal(r.sent, 3)
  assert.deepEqual(sent.filter((x) => x.content?.text).map((x) => x.content.text), ['text f1', 'text f2', 'text f3'])
  assert.equal(s.store.messageList(B, ME, {}).length, 3)
  s.shutdown()
})

test('fetchOlder pages back from the oldest message that is kept', async () => {
  const { s } = account()
  let asked = null
  s.sock.fetchMessageHistory = async (count, key, ts) => { asked = { count, key, ts } }
  const t = now() - 100
  feed(s, [incoming('old', A, 'oldest', { ts: t }), incoming('new', A, 'newest', { ts: t + 50 })])
  assert.deepEqual(await s.fetchOlder(A), { requested: true })
  assert.equal(asked.key.id, 'old')
  assert.equal(asked.ts, t)
  s.shutdown()
})

test('removing the account closes its database, and a late send does not blow up', async () => {
  const { s, dir } = account()
  feed(s, [incoming('x', A, 'hi')])
  await s.destroy()
  assert.equal(fs.existsSync(dir), false)
  assert.doesNotThrow(() => s.store.addMessage({ id: 'late', jid: A, fromMe: true, ts: now(), type: 'text', text: 'late' }))
  assert.deepEqual(s.store.messageList(A, ME, {}), [])
})

test('after a restart everything is still there, including what was only pending', () => {
  const { s, dir } = account()
  const t = now() - 10
  feed(s, [incoming('k1', A, 'one', { ts: t }), incoming('k2', G, 'group', { ts: t + 1, key: { participant: B } })])
  s.shutdown() // as on SIGTERM
  const again = new Session({ key: 'anna', label: 'Anna', dir })
  assert.deepEqual(ids(again.store.messageList(A, ME, {})), ['k1'])
  assert.equal(again.store.messageList(G, ME, {})[0].sender, B)
  assert.equal(again.store.chats.get(A).unread, 1)
  again.shutdown()
})
