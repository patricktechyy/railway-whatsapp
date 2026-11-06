import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Store as Legacy } from './fixtures/legacy-store.js'
import { Store as Sql } from '../store.js'

// The same random operations go to the old in-memory store and to the SQLite one. Whatever the page can
// ask for (chat list, message pages, names, unread counts, hidden ids still to resolve) has to come out the same.

function rng(seed) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}
const PNS = Array.from({ length: 6 }, (_, i) => `658000000${i}@s.whatsapp.net`)
const LIDS = Array.from({ length: 4 }, (_, i) => `9000${i}@lid`)
const GROUPS = ['120363000000000001@g.us', '120363000000000002@g.us']
const CHATS = [...PNS, ...LIDS, ...GROUPS]
const ME = PNS[0]
const WORDS = ['hello', 'ok', 'later', '*bold*', 'see you', 'lunch?', 'photo', 'https://example.com/x', 'thanks', '😀']

/** JSON with the keys in a fixed order: how the keys happen to be ordered is not something the page sees. */
function stable(v) {
  return JSON.stringify(v, (k, x) => {
    if (k === 'at' && typeof x === 'number' && x > 1e12) return 0 // when a version was kept: the real clock, a millisecond apart
    return x && typeof x === 'object' && !Array.isArray(x) ? Object.fromEntries(Object.entries(x).sort(([p], [q]) => (p < q ? -1 : p > q ? 1 : 0))) : x
  })
}

const dirs = []
function open(Cls, name) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `wa-diff-${name}-`))
  dirs.push(dir)
  return { Cls, file: path.join(dir, 'store.json') }
}

function snapshot(s) {
  const out = { chats: s.chatList(), locked: s.chatList({ lockedOnly: true }), contacts: s.contactList('', 200), pending: s.pendingLids().sort() }
  out.names = [...PNS, ...LIDS, ...GROUPS].map((j) => s.displayName(j))
  out.lists = {}
  for (const j of [...CHATS]) {
    const c = s.canon(j)
    if (out.lists[c]) continue
    const all = s.messageList(c, ME, {})
    out.lists[c] = { all, tail: s.messageList(c, ME, { limit: '3' }), oldest: s.oldest(c)?.id ?? null }
    if (all.length > 4) {
      const mid = all[all.length >> 1].id
      out.lists[c].before = s.messageList(c, ME, { beforeId: mid, limit: '2' })
      out.lists[c].since = s.messageList(c, ME, { sinceId: mid, limit: '1' })
    }
  }
  return JSON.parse(JSON.stringify(out))
}

function same(a, b, where) {
  if (stable(a) === stable(b)) return
  const keys = Object.keys(a)
  for (const k of keys) {
    if (stable(a[k]) !== stable(b[k])) {
      assert.deepEqual(b[k], a[k], `${where}: "${k}" differs (first is the old store)`)
    }
  }
  assert.fail(`${where}: differs`)
}

function run(seed, steps) {
  const r = rng(seed)
  const pick = (list) => list[Math.floor(r() * list.length)]
  const A = open(Legacy, 'old')
  const B = open(Sql, 'new')
  let a = new A.Cls(A.file)
  let b = new B.Cls(B.file)
  let hist = false
  for (const s of [a, b]) s.histOn = () => hist
  let counter = 0
  const base = Math.floor(Date.now() / 1000) - 3000
  let cursor = base
  const both = (fn) => {
    const ra = fn(a, 'old')
    const rb = fn(b, 'new')
    assert.equal(stable(rb ?? null), stable(ra ?? null), `seed ${seed}: results differ`)
  }
  const existing = (jid) => a.messageList(a.canon(jid), ME, { limit: '40' })

  for (let i = 0; i < steps; i++) {
    const roll = r()
    const raw = pick(CHATS)
    const jid = a.canon(raw)
    const group = jid.endsWith('@g.us')
    const known = existing(jid)
    const target = known.length ? pick(known) : null
    if (roll < 0.42) {
      // a message: new, or a re-sent copy of one we have
      const resend = target && r() < 0.15
      const fromMe = !group && r() < 0.25 ? true : !group ? false : r() < 0.15
      const type = r() < 0.2 ? 'image' : 'text'
      const id = resend ? target.id : `m${++counter}`
      let ts = resend ? target.ts : r() < 0.7 ? (cursor += Math.floor(r() * 4)) : cursor - Math.floor(r() * 20) // ties, and late arrivals
      const sender = group && !fromMe && r() > 0.2 ? a.canon(pick([...PNS, ...LIDS])) : undefined
      const quote = group && target && r() < 0.3 ? { id: target.id, text: 'q', sender: pick([...PNS, ...LIDS]), fromMe: false } : undefined
      const text = type === 'image' ? '' : `${pick(WORDS)} ${pick(WORDS)}`
      const bump = r() < 0.6
      both((s) => {
        const m = { id, jid, fromMe, ts, type, text, sender, quote: quote && { ...quote }, rm: type === 'image' ? { message: { imageMessage: { x: 1 } } } : undefined, rj: jid !== raw ? raw : undefined }
        return s.addMessage(m, { bumpUnread: bump })?.id
      })
    } else if (roll < 0.5 && target) {
      both((s) => s.removeMessage(jid, target.id))
    } else if (roll < 0.56 && target) {
      both((s) => s.markDeleted(jid, target.id))
    } else if (roll < 0.62 && target) {
      const text = `edit ${i}`
      both((s) => s.markEdited(jid, target.id, text))
    } else if (roll < 0.7 && target) {
      const who = pick(PNS)
      const emoji = r() < 0.3 ? '' : pick(['👍', '❤️', '😂'])
      both((s) => s.setReaction(jid, target.id, who, emoji))
    } else if (roll < 0.74) {
      const k = Math.floor(r() * LIDS.length)
      both((s) => s.link(LIDS[k], PNS[k + 1]))
    } else if (roll < 0.78) {
      const who = pick(PNS)
      const info = r() < 0.5 ? { name: `Name${i}` } : { notify: `Notify${i}` }
      both((s) => s.setContact(who, info))
    } else if (roll < 0.8) {
      const nick = r() < 0.3 ? '' : `Nick${i}`
      both((s) => s.setNick(jid, nick))
    } else if (roll < 0.83) {
      const on = r() < 0.5
      both((s) => s.setLocked(jid, on))
    } else if (roll < 0.87) {
      const patch = pick([{ localPinned: true }, { localPinned: false }, { localArchived: true }, { localMute: Date.now() + 9e9 }, { localMute: 0 }, { waMute: -1 }])
      both((s) => (s.touchChat(jid, patch), null))
    } else if (roll < 0.9) {
      both((s) => (s.markRead(jid), null))
    } else if (roll < 0.92) {
      const g = pick(GROUPS)
      both((s) => (s.setGroup(g, `Group ${i}`), null))
    } else if (roll < 0.93) {
      hist = !hist
    }
    if (i % 40 === 39) same(snapshot(a), snapshot(b), `seed ${seed} step ${i}`)
  }
  same(snapshot(a), snapshot(b), `seed ${seed} end`)

  // save both and open them again: what comes back has to match too
  a.close()
  b.close()
  a = new A.Cls(A.file)
  b = new B.Cls(B.file)
  for (const s of [a, b]) s.histOn = () => hist
  same(snapshot(a), snapshot(b), `seed ${seed} after reopening`)
  a.close()
  b.close()
}

test('old and new store agree on 40 random runs of 300 operations each', () => {
  for (let seed = 1; seed <= 40; seed++) run(seed, 300)
})

test('old and new store agree on one long run', () => {
  run(777, 2500)
})

test.after(() => {
  for (const d of dirs) fs.rmSync(d, { recursive: true, force: true })
})
