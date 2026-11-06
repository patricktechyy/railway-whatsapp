import fs from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'

const MAX_CHATS = Number(process.env.MAX_CHATS || 800)
// A chat-list preview is one line that the page cuts off with an ellipsis, so there is no use in keeping
// a whole 60,000-character message in memory for every chat.
const PREVIEW_MAX = 300
export function clipPreview(s) {
  s = String(s || '')
  if (s.length <= PREVIEW_MAX) return s
  let t = s.slice(0, PREVIEW_MAX)
  const c = t.charCodeAt(t.length - 1)
  if (c >= 0xd800 && c <= 0xdbff) t = t.slice(0, -1) // never cut an emoji in half
  return t
}
// Message retention is time-based so a busy chat cannot evict recent messages
// simply because it crossed an arbitrary message-count cap. This is especially
// important for groups where thousands of messages can arrive within a day.
// HISTORY_DAYS is the actual retention boundary; default 14 gives a full week
// of scrollback with some breathing room. The server may override it via an
// environment variable, but it never goes below MIN_HISTORY_DAYS.
export const MIN_HISTORY_DAYS = 7
export const MAX_HISTORY_DAYS = 3650
const DEFAULT_HISTORY_DAYS = 14
let historyDays = Math.max(MIN_HISTORY_DAYS, Number(process.env.HISTORY_DAYS) || DEFAULT_HISTORY_DAYS)
export const getHistoryDays = () => historyDays
export function setHistoryDays(n) {
  historyDays = Math.min(MAX_HISTORY_DAYS, Math.max(MIN_HISTORY_DAYS, Math.round(Number(n)) || MIN_HISTORY_DAYS))
  return historyDays
}
export const historyCutoff = () => Math.floor(Date.now() / 1000) - historyDays * 86400

export const isLid = (j) => typeof j === 'string' && j.endsWith('@lid')
export const isPn = (j) => typeof j === 'string' && j.endsWith('@s.whatsapp.net')
export const isGroup = (j) => typeof j === 'string' && j.endsWith('@g.us')

/** "123:4@s.whatsapp.net" -> "123@s.whatsapp.net" (strip the device suffix) */
export const bare = (j) => (typeof j === 'string' ? j.replace(/:\d+(?=@)/, '') : j)

/** Accept a JID or a bare phone number and return a phone JID, or null. */
export function toPn(v) {
  if (!v) return null
  if (isPn(v)) return bare(v)
  const digits = String(v).replace(/\D/g, '')
  return /^\d{6,16}$/.test(digits) && !String(v).includes('@') ? `${digits}@s.whatsapp.net` : null
}

/** "+62 812-3456-7890" and the like: a number dressed up as a name. */
// Also catches the masked numbers WhatsApp puts in place of a name for some
// chats (e.g. "+65••••••46"), which would otherwise beat the real saved name.
export const looksLikePhone = (s) => typeof s === 'string' && /^[+\d\s().\-•·∙⋅*…]{6,}$/.test(s.trim()) && /\d/.test(s)

export const phoneOf = (jid) => (isPn(jid) ? '+' + jid.split('@')[0] : '')

// ---------------------------------------------------------------- database
// Every message lives in one SQLite file per account (messages.db), not in memory. The rest of what
// the store knows (chats, contacts, who a hidden id is, locks) is small and stays in memory, saved to
// chat-meta.json. Before this, both lived in store.json, which is moved over once (see migrateLegacy).
const PRAGMAS = `
PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;
PRAGMA cache_size = -1024;
PRAGMA mmap_size = 0;
PRAGMA busy_timeout = 5000;
PRAGMA journal_size_limit = 4194304;
`
// seq is the arrival order: messages sort by (ts, seq), so two with the same time keep the order they came in.
const SCHEMA = `
CREATE TABLE IF NOT EXISTS msg (
  seq INTEGER PRIMARY KEY,
  jid TEXT NOT NULL,
  id TEXT NOT NULL,
  ts INTEGER NOT NULL,
  sender TEXT,
  qid TEXT,
  qsender TEXT,
  from_me INTEGER NOT NULL DEFAULT 0,
  rs INTEGER NOT NULL DEFAULT 0,
  doc TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS msg_jid_id ON msg (jid, id);
CREATE INDEX IF NOT EXISTS msg_jid_ts ON msg (jid, ts, seq);
CREATE INDEX IF NOT EXISTS msg_ts ON msg (ts);
CREATE INDEX IF NOT EXISTS msg_q ON msg (jid, qid) WHERE qid IS NOT NULL;
CREATE TABLE IF NOT EXISTS grp (jid TEXT PRIMARY KEY, doc TEXT NOT NULL);
`
const COLS = 'jid, id, ts, sender, qid, qsender, from_me, rs, doc'
const SQL = {
  insert: `INSERT INTO msg (${COLS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  insertIgnore: `INSERT OR IGNORE INTO msg (${COLS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  update: 'UPDATE msg SET ts = ?, sender = ?, qid = ?, qsender = ?, from_me = ?, rs = ?, doc = ? WHERE jid = ? AND id = ?',
  get: 'SELECT doc FROM msg WHERE jid = ? AND id = ?',
  pos: 'SELECT ts, seq FROM msg WHERE jid = ? AND id = ?',
  del: 'DELETE FROM msg WHERE jid = ? AND id = ?',
  first: 'SELECT doc FROM msg WHERE jid = ? ORDER BY ts, seq LIMIT 1',
  last: 'SELECT doc FROM msg WHERE jid = ? ORDER BY ts DESC, seq DESC LIMIT 1',
  all: 'SELECT doc FROM msg WHERE jid = ? ORDER BY ts, seq',
  tail: 'SELECT doc FROM msg WHERE jid = ? ORDER BY ts DESC, seq DESC LIMIT ?',
  since: 'SELECT doc FROM msg WHERE jid = ? AND (ts > ? OR (ts = ? AND seq >= ?)) ORDER BY ts, seq',
  before: 'SELECT doc FROM msg WHERE jid = ? AND (ts < ? OR (ts = ? AND seq < ?)) ORDER BY ts DESC, seq DESC LIMIT ?',
  countAfter: 'SELECT COUNT(*) AS n FROM msg WHERE jid = ? AND from_me = 0 AND (ts > ? OR (ts = ? AND seq > ?))',
  receipts: 'SELECT doc FROM msg WHERE jid = ? AND from_me = 0 AND rs = 0 ORDER BY ts DESC, seq DESC LIMIT ?',
  markReceipt: "UPDATE msg SET rs = 1, doc = json_set(doc, '$.rs', 1) WHERE jid = ? AND id = ?",
  replyTo: 'SELECT qsender FROM msg WHERE jid = ? AND qid = ? ORDER BY seq DESC LIMIT 1',
  replies: "SELECT jid, qid, qsender FROM msg WHERE qid IS NOT NULL AND jid LIKE '%@g.us' ORDER BY seq",
  count: 'SELECT COUNT(*) AS n FROM msg',
  anyOld: 'SELECT 1 AS x FROM msg WHERE ts < ? LIMIT 1',
  prune: 'DELETE FROM msg WHERE ts < ?',
  mediaScan:
    "SELECT id, ts, json_extract(doc, '$.type') AS type, json_extract(doc, '$.deleted') AS del, json_type(doc, '$.rm') AS rm, " +
    "json_extract(doc, '$.fileName') AS fn, json_extract(doc, '$.text') AS text FROM msg WHERE jid = ? ORDER BY ts DESC, seq DESC",
  groupLids: "SELECT DISTINCT sender AS j FROM msg WHERE jid LIKE '%@g.us' AND sender LIKE '%@lid' UNION SELECT DISTINCT qsender FROM msg WHERE jid LIKE '%@g.us' AND qsender LIKE '%@lid'",
  // the old address's messages move to the new one: same time and order, and the address they really came from is kept (rj)
  merge:
    `INSERT OR IGNORE INTO msg (${COLS}) SELECT ?, id, ts, sender, qid, qsender, from_me, rs, ` +
    "json_set(doc, '$.jid', ?, '$.rj', COALESCE(NULLIF(json_extract(doc, '$.rj'), ''), ?)) FROM msg WHERE jid = ? ORDER BY ts, seq",
  dropChat: 'DELETE FROM msg WHERE jid = ?',
  grpGet: 'SELECT doc FROM grp WHERE jid = ?',
  grpHas: 'SELECT 1 FROM grp WHERE jid = ?',
  grpSet: 'INSERT OR REPLACE INTO grp (jid, doc) VALUES (?, ?)',
  grpDel: 'DELETE FROM grp WHERE jid = ?',
  grpClear: 'DELETE FROM grp',
}

let warnedJournal = false
function openDb(file) {
  const open = () => {
    const db = new DatabaseSync(file)
    try {
      db.exec(PRAGMAS)
      db.exec(SCHEMA)
    } catch (e) {
      try { db.close() } catch {} // a half-opened one would keep the file in use
      throw e
    }
    if (!warnedJournal) {
      warnedJournal = true
      try {
        const mode = String(db.prepare('PRAGMA journal_mode').get()?.journal_mode || '')
        if (mode.toLowerCase() !== 'wal') console.warn(`[store] the data volume would not use WAL mode (got "${mode}"); messages still work, just a little slower`)
      } catch {}
    }
    return db
  }
  try {
    return open()
  } catch (e) {
    // SQLITE_CORRUPT and SQLITE_NOTADB. Disk-full, permission and locking errors must leave the database in place.
    if (![11, 26].includes(e.errcode & 0xff)) throw e
    // a damaged file must not take the account down: keep it for a look, start a fresh one
    const sideFiles = ['', '-wal', '-shm']
    const damaged = `${file}.damaged`
    let target = damaged
    for (let n = 1; sideFiles.some((s) => fs.existsSync(target + s)); n++) target = `${damaged}.${n}`
    console.error(`[store] ${file} could not be opened (${e.message}); moving it aside and starting a fresh one`)
    for (const s of ['-wal', '-shm', '']) {
      if (fs.existsSync(file + s)) fs.renameSync(file + s, target + s)
    }
    return open()
  }
}

/** The values of a message's row, from the message itself. */
function cols(m) {
  const q = m.quote
  return [
    m.jid,
    m.id,
    Number(m.ts) || 0,
    m.sender || null,
    q?.id && q.sender && !q.fromMe ? String(q.id) : null, // a reply to somebody else's message: who it quotes
    q?.sender ? String(q.sender) : null,
    m.fromMe ? 1 : 0,
    m.rs ? 1 : 0,
    JSON.stringify(m),
  ]
}

/**
 * Stores made before the database kept everything in one store.json. Moves the messages into messages.db
 * and the rest into chat-meta.json. The old store.json is deleted only once the new database has been
 * closed, opened again from disk and checked (it has every message, and passes SQLite's own check);
 * keeping a second copy of everything would double what the account takes on the volume.
 * Safe to run again after a crash: chat-meta.json is written last, and its presence says "done".
 * Returns true if something was moved. Throws if the disk hasn't room (nothing is touched then).
 */
export function migrateLegacy(file) {
  const dir = path.dirname(file)
  const metaFile = path.join(dir, 'chat-meta.json')
  const dbFile = path.join(dir, 'messages.db')
  if (fs.existsSync(metaFile) || !fs.existsSync(file)) return false
  const size = fs.statSync(file).size
  let free = Infinity
  try {
    const st = fs.statfsSync(dir)
    free = st.bavail * st.bsize
  } catch {}
  if (free < size + 64 * 1048576) {
    throw new Error(`not enough free disk space to move ${Math.round(size / 1048576)} MB of messages into the new database (${Math.round(free / 1048576)} MB free)`)
  }
  let source = fs.readFileSync(file, 'utf8')
  let raw
  try {
    raw = JSON.parse(source)
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('Invalid store')
  } catch {
    // unreadable, as before this starts the account empty; the file is kept for a look
    let target = `${file}.unreadable`
    for (let n = 1; fs.existsSync(target); n++) target = `${file}.unreadable.${n}`
    fs.renameSync(file, target)
    return false
  }
  source = null
  const started = Date.now()
  for (const s of ['', '-wal', '-shm']) fs.rmSync(dbFile + s, { force: true }) // an earlier attempt that stopped half way
  const db = openDb(dbFile)
  let n = 0
  let added = 0
  try {
    db.exec('PRAGMA synchronous = FULL')
    const ins = db.prepare(SQL.insertIgnore)
    db.exec('BEGIN')
    for (const [jid, list] of Object.entries(raw.messages || {})) {
      for (const m of Array.isArray(list) ? list : []) {
        if (!m || typeof m !== 'object' || !m.id) continue
        m.jid = jid
        added += Number(ins.run(...cols(m)).changes)
        // small batches, so the write-ahead file stays small too
        if (++n % 2000 === 0) { db.exec('COMMIT'); db.exec('BEGIN') }
      }
      raw.messages[jid] = null // let go of it as we go
    }
    db.exec('COMMIT')
    db.exec('PRAGMA wal_checkpoint(TRUNCATE)')
  } finally {
    db.close()
  }
  // Look at what is really on disk before the old file goes: a fresh connection, every message there, no damage
  verifyMessageDb(dbFile, added)
  const meta = { chats: raw.chats || [], contacts: raw.contacts || [], alias: raw.alias || [], gone: raw.gone || [], locked: raw.locked || [], migratedAt: Date.now(), migratedMessages: added }
  const tmp = `${metaFile}.tmp`
  fs.writeFileSync(tmp, JSON.stringify(meta), { flush: true })
  fs.renameSync(tmp, metaFile) // the commit point (migratedAt tells a start after a crash to finish the clean-up below)
  fs.rmSync(file, { force: true })
  console.log(`[store] ${dir}: moved ${added} messages into the database in ${((Date.now() - started) / 1000).toFixed(1)}s; the old store.json is deleted`)
  return true
}

function verifyMessageDb(file, expectedRows) {
  const check = new DatabaseSync(file, { readOnly: true })
  try {
    const rows = check.prepare('SELECT COUNT(*) AS n FROM msg').get().n
    const verdict = check.prepare('PRAGMA quick_check').get()?.quick_check
    if ((expectedRows != null && rows !== expectedRows) || verdict !== 'ok') {
      throw new Error(`the message database did not check out (${rows} messages, expected ${expectedRows ?? 'unknown'}, check: ${verdict})`)
    }
  } finally {
    check.close()
  }
}

/**
 * What WhatsApp says about the groups an account is in (their members, above all, which can be hundreds per
 * group). Kept in the database, with the few used lately in memory: a Map of all of them would hold every
 * member of every group for as long as the server runs. It starts empty each time the server starts and is
 * filled again when WhatsApp connects, so a member list is never older than the connection.
 * get / set / delete / has, like a Map; what comes back is for reading, not changing.
 */
export class GroupCache {
  constructor(store, keep = 8) {
    this.store = store
    this.keep = keep
    this.recent = new Map() // jid -> metadata, least recently used first
  }
  remember(jid, md, stored) {
    this.recent.delete(jid)
    this.recent.set(jid, { md, stored, at: Date.now() })
    while (this.recent.size > this.keep) this.recent.delete(this.recent.keys().next().value)
  }
  get(jid) {
    if (typeof jid !== 'string') return undefined
    const hit = this.recent.get(jid)
    if (hit) {
      this.remember(jid, hit.md, hit.stored)
      return hit.md
    }
    const row = this.store.q1(SQL.grpGet, jid)
    if (!row) return undefined
    const md = JSON.parse(row.doc)
    this.remember(jid, md, true)
    return md
  }
  has(jid) {
    return typeof jid === 'string' && (this.recent.has(jid) || !!this.store.q1(SQL.grpHas, jid))
  }
  set(jid, md) {
    if (typeof jid !== 'string' || !md || typeof md !== 'object') return this
    this.remember(jid, md, false)
    let doc
    try {
      doc = JSON.stringify(md)
    } catch {
      this.store.qw(SQL.grpDel, jid)
      return this // can't be stored: it stays in memory for now, and is asked for again when it is gone
    }
    if (typeof doc !== 'string') {
      this.store.qw(SQL.grpDel, jid)
      return this
    }
    if (this.store.qw(SQL.grpSet, jid, doc).changes) this.remember(jid, md, true)
    return this
  }
  evictBefore(cutoff) {
    for (const [jid, entry] of this.recent) {
      if (entry.stored && entry.at <= cutoff) this.recent.delete(jid)
    }
  }
  delete(jid) {
    this.recent.delete(jid)
    return this.store.qw(SQL.grpDel, jid).changes > 0
  }
  clear() {
    this.recent.clear()
    if (this.store.q1('SELECT 1 AS x FROM grp LIMIT 1')) this.store.qw(SQL.grpClear) // (no write at all when there is nothing to clear)
  }
}

/**
 * Chats, contacts and who-is-who live in Maps and are saved to chat-meta.json every few seconds; messages
 * live in messages.db. Chats are keyed by a *canonical* JID: the phone JID when we know it, otherwise the
 * LID. When a LID→phone mapping turns up later, the LID chat is merged into the phone chat so one person
 * never shows up twice.
 *
 * The database connection keeps one write open and commits it every few seconds (and on close), so a
 * crash loses at most that much, as the old snapshot did. Reads on the same connection see the pending writes.
 */
export class Store {
  /** `file` is where the old store.json was; the other files sit next to it. */
  constructor(file) {
    this.file = file
    this.dir = path.dirname(file)
    this.metaFile = path.join(this.dir, 'chat-meta.json')
    this.dbFile = path.join(this.dir, 'messages.db')
    this.chats = new Map() //    jid -> { jid, subject?, t, unread, preview, cap? }
    this.contacts = new Map() // jid -> { name?, notify?, verified? }
    this.alias = new Map() //    lid -> phone jid
    this.aliasVersion = 0
    this.gone = new Set() //     message ids deleted "for me" (never re-added)
    this.locked = new Set() //   chats behind the chat lock (canonical jids)
    this.lids = new Set() //     hidden ids that wrote or were quoted in a group
    this.dirty = false
    this.closed = false
    this.txOpen = false
    this.lastPrune = 0
    this.stmts = new Map()
    this.load()
    // a little off 5 s, so a few dozen accounts don't all save in the same instant
    this.timer = setInterval(() => this.flush(), 5000 + Math.floor(Math.random() * 1000))
    this.timer.unref?.()
  }

  // ------------------------------------------------------------ persistence
  load() {
    fs.mkdirSync(this.dir, { recursive: true })
    migrateLegacy(this.file)
    let raw
    try { raw = JSON.parse(fs.readFileSync(this.metaFile, 'utf8')) } catch {}
    const oldCopy = `${this.file}.migrated`
    const finishMigration = raw?.migratedAt && fs.existsSync(this.file)
    if (finishMigration || fs.existsSync(oldCopy)) {
      // A previous build or interrupted migration left a second copy. Verify the database again before
      // deleting it, and stop the account if the database is missing or damaged.
      verifyMessageDb(this.dbFile, finishMigration ? raw.migratedMessages : undefined)
      if (finishMigration) fs.rmSync(this.file, { force: true })
      fs.rmSync(oldCopy, { force: true })
    }
    try {
      for (const c of raw?.chats || []) {
        if (typeof c.preview === 'string') c.preview = clipPreview(c.preview)
        this.chats.set(c.jid, c)
      }
      for (const [jid, c] of raw?.contacts || []) {
        // older snapshots stored a plain string name
        const info = typeof c === 'string' ? { notify: c } : { ...c }
        for (const k of ['name', 'verified', 'notify']) if (looksLikePhone(info[k])) delete info[k]
        this.contacts.set(jid, info)
      }
      for (const [lid, pn] of raw?.alias || []) this.alias.set(lid, pn)
      for (const id of raw?.gone || []) this.gone.add(id)
      for (const j of raw?.locked || []) this.locked.add(j)
    } catch {
      /* first run or unreadable snapshot: start empty */
    }
    this.db = openDb(this.dbFile)
    this.groups = new GroupCache(this)
    this.groups.clear() // member lists are not carried over a restart (they could be out of date by then)
    this.loadLids()
    this.repairSenders()
    this.prune()
  }

  flush() {
    if (this.closed) return
    if (Date.now() - this.lastPrune > 60e3) this.prune()
    this.commit()
    if (!this.dirty || this.txOpen) return
    try {
      const chats = [...this.chats.values()]
        .sort((a, b) => (b.t || 0) - (a.t || 0))
        .slice(0, MAX_CHATS)
      fs.mkdirSync(this.dir, { recursive: true })
      const tmp = this.metaFile + '.tmp'
      fs.writeFileSync(
        tmp,
        JSON.stringify({ chats, contacts: [...this.contacts], alias: [...this.alias], gone: [...this.gone].slice(-3000), locked: [...this.locked] })
      )
      fs.renameSync(tmp, this.metaFile)
      this.dirty = false
    } catch (e) {
      console.error('store flush failed:', e.message)
    }
  }

  close() {
    if (this.closed) return
    clearInterval(this.timer)
    this.flush()
    this.commit()
    this.closed = true
    try { this.db.close() } catch {}
    this.stmts.clear()
  }

  /** Is anything not on disk yet? (for the status page) */
  get pending() {
    return this.dirty || this.txOpen
  }

  /** Bytes the store takes on disk. */
  bytes() {
    let n = 0
    for (const f of [this.metaFile, this.dbFile, `${this.dbFile}-wal`]) {
      try { n += fs.statSync(f).size } catch {}
    }
    return n
  }

  /** How many messages are kept. */
  count() {
    return this.q1(SQL.count)?.n || 0
  }

  // ------------------------------------------------------------- database
  st(sql) {
    let s = this.stmts.get(sql)
    if (!s) {
      s = this.db.prepare(sql)
      this.stmts.set(sql, s)
    }
    return s
  }
  q1(sql, ...p) {
    return this.closed ? undefined : this.st(sql).get(...p)
  }
  qa(sql, ...p) {
    return this.closed ? [] : this.st(sql).all(...p)
  }
  /** A write: opens the pending transaction if there isn't one. */
  qw(sql, ...p) {
    if (this.closed) return { changes: 0 }
    this.begin()
    return this.st(sql).run(...p)
  }
  begin() {
    if (this.txOpen) return
    this.db.exec('BEGIN')
    this.txOpen = true
  }
  commit() {
    if (!this.txOpen || this.closed) return
    try {
      this.db.exec('COMMIT')
      this.txOpen = false
    } catch (e) {
      console.error('store commit failed:', e.message)
      // SQLite can roll back by itself on some errors. Older Node 22 builds lack isTransaction.
      this.txOpen = this.db.isTransaction ?? !/no transaction is active/i.test(e.message)
    }
  }

  /** Delete what has aged out of the history window (at most once a minute). */
  prune() {
    this.lastPrune = Date.now()
    const cutoff = historyCutoff()
    if (!this.q1(SQL.anyOld, cutoff)) return 0
    const r = this.qw(SQL.prune, cutoff)
    if (r.changes) this.loadLids()
    return r.changes
  }

  parse(row) {
    return row ? JSON.parse(row.doc) : null
  }

  /** Who wrote in groups under a hidden id (LID), for pendingLids. */
  loadLids() {
    this.lids.clear()
    for (const r of this.qa(SQL.groupLids)) if (r.j) this.lids.add(r.j)
  }
  noteLids(m) {
    if (!isGroup(m.jid)) return
    for (const j of [m.sender, m.quote?.sender]) if (isLid(j)) this.lids.add(j)
  }

  /** Write a message's row: a new one, or an update of the one with this id. Returns rows changed. */
  writeRow(m, isNew) {
    if (this.closed) return 0
    const c = cols(m)
    this.begin()
    if (isNew) {
      this.st(SQL.insert).run(...c)
      this.noteLids(m)
      return 1
    }
    const r = this.st(SQL.update).run(c[2], c[3], c[4], c[5], c[6], c[7], c[8], c[0], c[1])
    if (r.changes) this.noteLids(m)
    return r.changes
  }

  /**
   * Save a message that was changed after being read (findMessage hands out copies, not the stored one).
   * It only ever updates: a message that was deleted or moved in the meantime stays gone.
   */
  saveMessage(m) {
    if (!m?.jid || !m?.id) return false
    return this.writeRow(m, false) > 0
  }

  /** The message in a chat with this id, as saved; `jid` must already be the chat's canonical address. */
  getMessage(jid, id) {
    return this.parse(this.q1(SQL.get, jid, id))
  }

  /** Every message of a chat, oldest first. */
  allMessages(jid) {
    return this.qa(SQL.all, this.canon(jid)).map((r) => JSON.parse(r.doc))
  }

  // ----------------------------------------------------------- identities
  canon(jid) {
    const b = bare(jid)
    return this.alias.get(b) || b
  }

  /** Record lid <-> phone. Returns true if anything changed. */
  link(lid, pn) {
    lid = bare(lid)
    pn = toPn(pn)
    if (!isLid(lid) || !pn || this.alias.get(lid) === pn) return false
    this.alias.set(lid, pn)
    this.aliasVersion++
    this.merge(lid, pn)
    this.dirty = true
    try { this.onNames?.() } catch {}
    return true
  }

  /** Link two JIDs where we don't know which one is the LID. */
  linkPair(a, b) {
    if (!a || !b) return false
    if (isLid(a) && (isPn(b) || toPn(b))) return this.link(a, b)
    if (isLid(b) && (isPn(a) || toPn(a))) return this.link(b, a)
    return false
  }

  merge(from, to) {
    this.moveLock(from, to)
    const fc = this.contacts.get(from)
    if (fc) {
      this.contacts.set(to, { ...fc, ...pickDefined(this.contacts.get(to)) })
      this.contacts.delete(from)
    }
    const fchat = this.chats.get(from)
    if (fchat) {
      const tchat = this.chats.get(to)
      if (tchat) {
        tchat.unread = (tchat.unread || 0) + (fchat.unread || 0)
        if ((fchat.t || 0) > (tchat.t || 0)) {
          tchat.t = fchat.t
          tchat.preview = fchat.preview
        }
        tchat.cap = Math.max(tchat.cap || 0, fchat.cap || 0) || undefined
      } else {
        this.chats.set(to, { ...fchat, jid: to })
      }
      this.chats.delete(from)
    }
    // messages: a copy that is already in the new chat wins; the rest come over in order, keeping the address they came from (rj)
    this.qw(SQL.merge, to, to, from, from)
    this.qw(SQL.dropChat, from)
  }

  setContact(jid, info = {}) {
    if (!jid) return
    jid = this.canon(jid)
    if (isGroup(jid)) return
    const cur = this.contacts.get(jid) || {}
    info = { ...info }
    for (const k of ['name', 'verified', 'notify']) if (looksLikePhone(info[k])) delete info[k]
    const next = { ...cur, ...pickDefined(info) }
    if (JSON.stringify(cur) === JSON.stringify(next)) return
    this.contacts.set(jid, next)
    this.dirty = true
  }

  setGroup(jid, subject) {
    if (!isGroup(jid) || !subject) return
    const chat = this.chats.get(jid)
    if (chat) {
      if (chat.subject !== subject) {
        chat.subject = subject
        this.dirty = true
      }
    } else {
      this.chats.set(jid, { jid, subject, t: 0, unread: 0, preview: '' })
      this.dirty = true
    }
  }

  displayName(jid) {
    if (!jid) return ''
    jid = this.canon(jid)
    const c = this.contacts.get(jid) || {}
    if (c.nick) return c.nick // local nickname beats everything
    if (isGroup(jid)) return this.chats.get(jid)?.subject || 'Group'
    const ok = (v) => v && !looksLikePhone(v)
    return (ok(c.name) && c.name) || (ok(c.verified) && c.verified) || (ok(c.notify) && c.notify) || phoneOf(jid) || 'Unknown contact'
  }

  /** The name the person set on their own WhatsApp profile, if we've seen it. */
  profileName(jid) {
    const c = this.contacts.get(this.canon(jid)) || {}
    return c.notify && !looksLikePhone(c.notify) ? c.notify : ''
  }

  /** Nickname only this site shows. Empty clears it. Never sent to WhatsApp. */
  setNick(jid, nick) {
    jid = this.canon(jid)
    const c = { ...(this.contacts.get(jid) || {}) }
    nick = String(nick || '').trim().slice(0, 60)
    if (nick) c.nick = nick
    else delete c.nick
    this.contacts.set(jid, c)
    this.dirty = true
    return this.displayName(jid)
  }

  // ------------------------------------------------------------ chat lock
  isLocked(jid) { return !!jid && this.locked.size > 0 && this.locked.has(this.canon(jid)) }
  setLocked(jid, on) {
    const j = this.canon(jid)
    if (on) this.locked.add(j)
    else this.locked.delete(j)
    this.dirty = true
    return this.locked.has(j)
  }
  /** Keep locks on the right chat when a hidden id turns out to be a known number. */
  moveLock(from, to) {
    if (this.locked.delete(from)) { this.locked.add(to); this.dirty = true }
  }

  // ------------------------------------------------------------ chats/msgs
  touchChat(jid, patch = {}) {
    let chat = this.chats.get(jid)
    if (!chat) {
      chat = { jid, t: 0, unread: 0, preview: '' }
      this.chats.set(jid, chat)
    }
    if (patch.t != null && patch.t > (chat.t || 0)) chat.t = patch.t
    if (patch.unread != null) chat.unread = patch.unread
    if (patch.localArchived != null) chat.localArchived = !!patch.localArchived
    if (patch.localPinned != null) chat.localPinned = !!patch.localPinned
    // muted until (ms, -1 = always, 0 = not): on this site, and as WhatsApp on the phone says
    if (patch.localMute !== undefined) { if (patch.localMute) chat.localMute = patch.localMute; else delete chat.localMute }
    if (patch.waMute !== undefined) { if (patch.waMute) chat.waMute = patch.waMute; else delete chat.waMute }
    this.dirty = true
    return chat
  }

  addMessage(msg, { bumpUnread = false } = {}) {
    if (this.gone.has(msg.id)) return null // deleted for me: never bring it back
    const old = this.getMessage(msg.jid, msg.id)
    // the real message taking the place of its "waiting for this message" bubble counts as new
    const wasWaiting = !!old && old.waiting && !msg.waiting
    const isNew = !old
    if (isNew) this.writeRow(msg, true)
    else {
      // a re-sent copy often lacks fields we already know (a group message's sender, above all):
      // never let a missing field wipe a known one
      const merged = { ...old }
      for (const [k, v] of Object.entries(msg)) if (v !== undefined) merged[k] = v
      // a re-sync of the original must not undo a delete or an edit
      if (old.deleted) Object.assign(merged, { deleted: true, text: '', rm: undefined, quote: undefined })
      else if (old.edited) Object.assign(merged, { edited: true, text: old.text })
      if (wasWaiting) { delete merged.waiting; delete merged.gaveUp }
      this.writeRow(merged, false)
    }
    if (isGroup(msg.jid)) {
      // a reply says who wrote the message it quotes: fill in a group message that came without its sender
      const q = msg.quote
      if (q?.id && q.sender && !q.fromMe) this.fillSender(msg.jid, q.id, q.sender)
      // ...and the other way round: replies that were here before the message they quote
      if (isNew && !msg.fromMe) {
        const r = this.q1(SQL.replyTo, msg.jid, msg.id)
        if (r?.qsender) this.fillSender(msg.jid, msg.id, r.qsender)
      }
    }

    const chat = this.touchChat(msg.jid)
    // Retention is based on timestamp (prune), which guarantees a busy chat keeps at least the
    // configured number of recent days instead of truncating at an arbitrary count.
    if (msg.ts >= (chat.t || 0)) {
      chat.t = msg.ts
      chat.preview = clipPreview(previewOf(msg, this))
    }
    if (bumpUnread && (isNew || wasWaiting) && !msg.fromMe) chat.unread = (chat.unread || 0) + 1
    this.dirty = true
    return msg
  }

  refreshPreview(jid) {
    const chat = this.chats.get(jid)
    if (!chat) return
    const last = this.parse(this.q1(SQL.last, jid))
    chat.preview = last ? clipPreview(previewOf(last, this)) : ''
    this.dirty = true
  }

  /** Delete for me: gone from this site for good. */
  removeMessage(jid, id) {
    jid = this.canon(jid)
    const r = this.qw(SQL.del, jid, id)
    this.gone.add(id)
    this.refreshPreview(jid)
    return r.changes > 0
  }

  /** Deleted for everyone (by you or by them): keep a placeholder like WhatsApp. */
  /** Keep a version of a message (before it was deleted or edited), only when history is on for this account. */
  keepVersion(m, kind) {
    if (!this.histOn?.() || (kind === 'deleted' && m.deleted)) return
    const v = { kind, at: Date.now(), type: m.type, text: m.text || '' }
    if (kind === 'deleted' && m.rm) { v.rm = m.rm; if (m.fileName) v.fileName = m.fileName }
    m.hist = [...(m.hist || []), v].slice(-20)
  }
  /** What history shows for a message: each earlier version (oldest first), then how it is now. */
  historyOf(jid, id) {
    const m = this.findMessage(jid, id)
    if (!m?.hist?.length) return null
    return {
      versions: m.hist.map((v, n) => ({ n, kind: v.kind, at: v.at, type: v.type, text: v.text, media: !!v.rm, fileName: v.fileName })),
      now: { deleted: !!m.deleted, text: m.deleted ? '' : m.text, edited: !!m.edited },
    }
  }

  markDeleted(jid, id) {
    const m = this.findMessage(jid, id)
    if (!m) return null
    this.keepVersion(m, 'deleted')
    Object.assign(m, { deleted: true, text: '', rm: undefined, quote: undefined, reactions: undefined, edited: false })
    this.saveMessage(m)
    this.refreshPreview(this.canon(jid))
    return m
  }

  markEdited(jid, id, text) {
    const m = this.findMessage(jid, id)
    if (!m || m.deleted) return null
    if (String(text) !== m.text) this.keepVersion(m, 'edit')
    Object.assign(m, { text: String(text), edited: true })
    this.saveMessage(m)
    this.refreshPreview(this.canon(jid))
    return m
  }

  /** [{t: "6581234567", name: "Budi", me: false}] for highlighting @mentions */
  mentionView(m, mineJid) {
    if (!m.mentions?.length) return undefined
    const mine = mineJid ? this.canon(mineJid) : null
    return m.mentions.map((x) => {
      const me = !!mine && this.canon(x.j) === mine
      return { t: x.t, name: me ? 'You' : this.displayName(x.j), me }
    })
  }

  quoteView(q) {
    if (!q) return undefined
    return { id: q.id, text: q.text, name: q.fromMe ? 'You' : q.sender ? this.displayName(q.sender) : '' }
  }

  /**
   * A reply says who wrote the message it quotes. That fills in a group message saved without a sender,
   * and when the reply names them by number but the message by hidden id (LID) (or the other way round),
   * it tells us which number that LID is. Returns 1 if that linked two addresses.
   */
  fillSender(jid, id, quotedSender) {
    const m = this.getMessage(jid, id)
    if (!m || m.fromMe) return 0
    const q = this.canon(quotedSender)
    if (!m.sender) {
      m.sender = q
      this.saveMessage(m)
      return 0
    }
    const s = this.canon(m.sender)
    if (s !== q && ((isLid(s) && isPn(q)) || (isPn(s) && isLid(q)))) return this.linkPair(s, q) ? 1 : 0
    return 0
  }

  /** At start: every group reply gets to tell us about the message it quotes. */
  repairSenders() {
    for (const r of this.qa(SQL.replies)) this.fillSender(r.jid, r.qid, r.qsender)
  }

  findMessage(jid, id) {
    return this.getMessage(this.canon(jid), id)
  }

  /** Add/replace one user's reaction on a message. Empty emoji removes it. */
  setReaction(jid, id, sender, emoji) {
    const m = this.findMessage(jid, id)
    if (!m || !sender) return null
    const reactions = Array.isArray(m.reactions) ? [...m.reactions] : []
    const idx = reactions.findIndex((r) => r?.sender === sender)
    if (!emoji) {
      if (idx >= 0) reactions.splice(idx, 1)
    } else if (idx >= 0) {
      reactions[idx] = { sender, emoji: String(emoji).slice(0, 16) }
    } else {
      reactions.push({ sender, emoji: String(emoji).slice(0, 16) })
    }
    m.reactions = reactions
    this.saveMessage(m)
    return m
  }

  reactionView(m, mineJid) {
    const rows = Array.isArray(m?.reactions) ? m.reactions : []
    const grouped = new Map()
    for (const r of rows) {
      if (!r?.emoji) continue
      const cur = grouped.get(r.emoji) || { emoji: r.emoji, count: 0, mine: false }
      cur.count++
      if (mineJid && this.canon(r.sender) === this.canon(mineJid)) cur.mine = true
      grouped.set(r.emoji, cur)
    }
    return [...grouped.values()]
  }

  oldest(jid) {
    return this.parse(this.q1(SQL.first, this.canon(jid)))
  }

  raiseCap(jid, by = 60) {
    // Kept for compatibility with the older fetch-older path. Recent-message
    // retention is now time-based, so there is no per-chat count cap to raise.
    this.touchChat(jid)
    return true
  }

  markRead(jid) {
    const chat = this.chats.get(jid)
    if (chat?.unread) {
      chat.unread = 0
      this.dirty = true
    }
  }

  // ------------------------------------------------------------ read receipts
  /** The newest incoming messages of a chat that we haven't sent a read receipt for (oldest first). */
  receiptBatch(jid, n) {
    return this.qa(SQL.receipts, jid, n).reverse().map((r) => JSON.parse(r.doc))
  }
  /** Note that read receipts went out for these messages. */
  markReceipts(jid, ids) {
    for (const id of ids) this.qw(SQL.markReceipt, jid, id)
  }
  /**
   * How many of the other side's messages come after the latest of these (read on another device).
   * -1: none of them is in the chat.
   */
  unreadAfter(jid, ids) {
    let best = null
    for (const id of ids) {
      const p = this.q1(SQL.pos, jid, id)
      if (p && (!best || p.ts > best.ts || (p.ts === best.ts && p.seq > best.seq))) best = p
    }
    if (!best) return -1
    return this.q1(SQL.countAfter, jid, best.ts, best.ts, best.seq)?.n ?? 0
  }
  /** These message ids in the order they sit in the chat (ids that aren't there are left out). */
  orderIds(jid, ids) {
    if (!ids.length || this.closed) return []
    const marks = ids.map(() => '?').join(', ')
    return this.db.prepare(`SELECT id FROM msg WHERE jid = ? AND id IN (${marks}) ORDER BY ts, seq`).all(jid, ...ids).map((r) => r.id)
  }

  // ------------------------------------------------------------- views
  /** The chat list: the unlocked chats, or (lockedOnly) just the locked ones. */
  chatList({ lockedOnly = false } = {}) {
    return [...this.chats.values()]
      .filter((c) => c.t && this.locked.has(c.jid) === lockedOnly)
      .sort((a, b) => (b.t || 0) - (a.t || 0))
      .slice(0, MAX_CHATS)
      .map((c) => ({
        jid: c.jid,
        name: this.displayName(c.jid),
        phone: phoneOf(c.jid),
        profile: this.profileName(c.jid),
        t: c.t,
        unread: c.unread || 0,
        preview: plainPreview(c.preview),
        group: isGroup(c.jid),
        archived: !!c.localArchived,
        pinned: !!c.localPinned,
        muted: this.mutedUntil(c.jid) || undefined, // ms, or -1 for always
        locked: lockedOnly || undefined,
      }))
  }

  /** When notifications for a chat come back: 0 (not muted), -1 (muted for good) or a time (ms). */
  mutedUntil(jid, now = Date.now()) {
    const c = this.chats.get(this.canon(jid))
    if (!c) return 0
    const live = (v) => (v === -1 || v > now ? v : 0)
    const a = live(c.localMute || 0), b = live(c.waMute || 0)
    if (a === -1 || b === -1) return -1
    return Math.max(a, b)
  }

  /** Newest `limit` messages, or a page before `beforeId`, or everything from `sinceId` on. */
  messageList(jid, mineJid, { beforeId, sinceId, limit } = {}) {
    jid = this.canon(jid)
    const group = isGroup(jid)
    const n = Math.max(1, Math.min(Number(limit) || 200, 5000))
    let rows
    if (sinceId) {
      const at = this.q1(SQL.pos, jid, sinceId)
      rows = at ? this.qa(SQL.since, jid, at.ts, at.ts, at.seq) : this.qa(SQL.tail, jid, n).reverse()
    } else if (beforeId) {
      const at = this.q1(SQL.pos, jid, beforeId)
      rows = at ? this.qa(SQL.before, jid, at.ts, at.ts, at.seq, n).reverse() : []
    } else if (limit) {
      rows = this.qa(SQL.tail, jid, n).reverse()
    } else {
      rows = this.qa(SQL.all, jid)
    }
    return rows.map((r) => this.messageView(JSON.parse(r.doc), mineJid, group))
  }

  /** A message as the page gets it. */
  messageView(m, mineJid, group) {
    return {
      id: m.id,
      jid: m.jid,
      fromMe: m.fromMe,
      status: m.fromMe ? (Number.isFinite(Number(m.status)) ? Math.max(0, Math.min(5, Number(m.status))) : 2) : undefined,
      rsum: m.fromMe && m.rsum ? m.rsum : undefined,
      ts: m.ts,
      type: m.type,
      text: m.text,
      gaveUp: m.gaveUp || undefined,
      media: !!m.rm,
      fileName: m.fileName,
      dur: m.dur || undefined,
      ptt: m.ptt || undefined,
      wf: m.wf,
      poll: this.pollView(m, mineJid),
      quote: this.quoteView(m.quote),
      deleted: !!m.deleted,
      edited: !!m.edited,
      hist: this.histOn?.() && m.hist?.length ? m.hist.length : undefined,
      fwd: m.fwd && !m.deleted ? m.fwd : undefined, // forwarding score (hops)
      senderName: group && !m.fromMe && m.sender ? this.displayName(m.sender) : '',
      sender: group && !m.fromMe ? m.sender : undefined,
      reactions: this.reactionView(m, mineJid),
      mentions: this.mentionView(m, mineJid),
    }
  }

  /** A poll as the page shows it: each answer with its votes (yours marked) and who voted. */
  pollView(m, mineJid) {
    if (!m?.poll) return undefined
    const mine = mineJid ? this.canon(mineJid) : null
    const options = m.poll.options.map((name) => ({ name, n: 0, mine: false, who: [] }))
    const votes = m.votes || {}
    for (const [who, picks] of Object.entries(votes)) {
      for (const i of picks) {
        const o = options[i]
        if (!o) continue
        o.n++
        if (who === mine) o.mine = true
        if (o.who.length < 12) o.who.push(who === mine ? 'You' : this.displayName(who))
      }
    }
    return { multi: !!m.poll.multi, options, voters: Object.keys(votes).length, canVote: !!m.poll.secret }
  }

  /** The chat's photos and videos, documents and links, newest first (up to 300 of each). */
  chatMedia(jid) {
    const media = [], docs = [], links = []
    if (!this.closed) {
      for (const r of this.st(SQL.mediaScan).iterate(this.canon(jid))) {
        if (r.del) continue
        if ((r.type === 'image' || r.type === 'video' || r.type === 'ptv') && r.rm) media.push({ id: r.id, type: r.type, ts: r.ts })
        else if (r.type === 'document' && r.rm) docs.push({ id: r.id, fileName: r.fn || 'Document', ts: r.ts })
        for (const u of String(r.text || '').match(/\bhttps?:\/\/[^\s<]+[^\s<.,;:!?)\]'"]/g) || []) links.push({ id: r.id, url: u.slice(0, 500), ts: r.ts })
        if (media.length >= 300 && docs.length >= 300 && links.length >= 300) break
      }
    }
    return { media: media.slice(0, 300), docs: docs.slice(0, 300), links: links.slice(0, 300) }
  }

  /** People you can start a chat with: contacts + existing chats. */
  contactList(q = '', limit = 60, { withLocked = false } = {}) {
    this.showLocked = withLocked
    const needle = q.trim().toLowerCase()
    const digits = needle.replace(/\D/g, '')
    const seen = new Set()
    const out = []
    const consider = (jid) => {
      jid = this.canon(jid)
      if (seen.has(jid) || jid.endsWith('@broadcast') || jid.endsWith('@newsletter')) return
      if (this.locked.has(jid) && !this.showLocked) return // locked chats stay out of "new chat" search
      seen.add(jid)
      const name = this.displayName(jid)
      const phone = phoneOf(jid)
      if (isLid(jid) && name === 'Unknown contact') return
      if (needle) {
        const hit =
          name.toLowerCase().includes(needle) || (digits.length >= 3 && phone.replace(/\D/g, '').includes(digits))
        if (!hit) return
      }
      out.push({ jid, name, phone, group: isGroup(jid), t: this.chats.get(jid)?.t || 0 })
    }
    for (const jid of this.chats.keys()) consider(jid)
    for (const jid of this.contacts.keys()) consider(jid)
    out.sort((a, b) => (b.t || 0) - (a.t || 0) || a.name.localeCompare(b.name))
    return out.slice(0, limit)
  }

  /** Every hidden id (LID) we still don't have a number for: chats, contacts, and people who wrote in groups. */
  pendingLids() {
    const s = new Set()
    const add = (j) => { if (isLid(j) && !this.alias.has(bare(j))) s.add(bare(j)) }
    for (const jid of this.chats.keys()) add(jid)
    for (const jid of this.contacts.keys()) add(jid)
    for (const j of this.lids) add(j)
    return [...s]
  }
}

function pickDefined(o = {}) {
  const r = {}
  for (const [k, v] of Object.entries(o || {})) if (v != null && v !== '') r[k] = v
  return r
}

/** A chat-list preview reads as plain text: WhatsApp's *bold* _italic_ ~strike~ marks come off, lines join up. */
export const plainPreview = (s) => String(s || '')
  .replace(/(^|[\s(])([*_~])(?=\S)([^\n]*?\S)\2(?=$|[\s).,!?:;])/g, '$1$3')
  .replace(/\s*\n+\s*/g, ' ')
  .trim()

export function previewOf(msg, store) {
  if (msg.deleted) return msg.fromMe ? '🚫 You deleted this message' : '🚫 This message was deleted'
  const body =
    msg.type === 'poll'
      ? '📊 ' + (msg.text || 'Poll')
      : msg.text && msg.type !== 'document'
      ? msg.text
      : {
          image: '📷 Photo',
          video: '🎥 Video',
          ptv: '📹 Video message',
          audio: '🎤 Voice message',
          document: '📄 ' + (msg.fileName || msg.text || 'Document'),
          sticker: 'Sticker',
          location: '📍 Location',
          contact: '👤 Contact',
        }[msg.type] || ''
  // "@6581234567" reads better as "@Budi" in the chat list
  let bodyText = body
  if (msg.mentions?.length && store) {
    for (const x of msg.mentions) bodyText = bodyText.split('@' + x.t).join('@' + store.displayName(x.j))
  }
  const who = msg.fromMe
    ? 'You: '
    : isGroup(msg.jid) && msg.sender && store
      ? store.displayName(msg.sender) + ': '
      : ''
  return who + bodyText
}
