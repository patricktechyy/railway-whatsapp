// node gen.mjs <dataDir> [accounts=12] [messagesPerAccount=20000]
// Makes a data volume the way the OLD version stored it: users.json plus one store.json per account.
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'

const [dataDir, nAcc = '12', nMsg = '20000'] = process.argv.slice(2)
const ACCOUNTS = Number(nAcc)
const MESSAGES = Number(nMsg)
let seed = 12345
const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296 }
const pick = (a) => a[Math.floor(rnd() * a.length)]
const hex = (n) => Array.from({ length: n }, () => Math.floor(rnd() * 16).toString(16)).join('')
const b64 = (n) => crypto.randomBytes(n).toString('base64')
const WORDS = 'ok lol see you later thanks bro can we meet at the mall tomorrow after school remember the assignment is due friday did you eat yet haha no worries send me the photo please call me when free happy birthday see the link below'.split(' ')
const sentence = () => Array.from({ length: 4 + Math.floor(rnd() * 28) }, () => pick(WORDS)).join(' ')

fs.mkdirSync(dataDir, { recursive: true })
const salt = crypto.randomBytes(16)
const hash = crypto.scryptSync('benchpass', salt, 64)
const pass = `scrypt$${salt.toString('base64url')}$${hash.toString('base64url')}`
const users = []
const now = Math.floor(Date.now() / 1000)

for (let a = 0; a < ACCOUNTS; a++) {
  const username = `user${a}`
  const dir = path.join('accounts', `${username}-${hex(8)}`)
  users.push({ username, name: `User ${a}`, dir, pass, pv: 1, setup: null, createdAt: Date.now() })
  const chats = []
  const jids = []
  for (let c = 0; c < 300; c++) {
    const jid = c < 250 ? `65${80000000 + a * 1000 + c}@s.whatsapp.net` : `1203630000${a}${String(c).padStart(4, '0')}@g.us`
    jids.push(jid)
  }
  const messages = Object.fromEntries(jids.map((j) => [j, []]))
  let ts0 = now - 12 * 86400
  for (let i = 0; i < MESSAGES; i++) {
    // a few busy chats get most of the traffic
    const ci = rnd() < 0.5 ? Math.floor(rnd() * 20) : Math.floor(rnd() * 300)
    const jid = jids[ci]
    const group = jid.endsWith('@g.us')
    const fromMe = !group && rnd() < 0.4
    const media = rnd() < 0.12
    const id = (fromMe ? '3EB0' : 'AC') + hex(18)
    const m = { id, jid, fromMe, ts: ts0 + Math.floor((i / MESSAGES) * 12 * 86400), type: media ? 'image' : 'text', text: media ? (rnd() < 0.3 ? sentence() : '') : sentence() }
    if (fromMe) m.status = 3
    if (group && !fromMe) m.sender = `65${81000000 + Math.floor(rnd() * 60)}@s.whatsapp.net`
    if (rnd() < 0.1) m.quote = { id: hex(20), text: sentence().slice(0, 100), sender: `65${81000000 + Math.floor(rnd() * 60)}@s.whatsapp.net`, fromMe: false }
    if (rnd() < 0.05) m.reactions = [{ sender: `65${81000000 + Math.floor(rnd() * 60)}@s.whatsapp.net`, emoji: '👍' }]
    if (media) {
      m.rm = { key: { remoteJid: jid, id, fromMe, participant: m.sender }, message: { imageMessage: { url: `https://mmg.whatsapp.net/v/t62.7118-24/${hex(8)}_${hex(16)}_${hex(10)}_n.enc?ccb=11-4&oh=${hex(32)}&oe=${hex(8)}&_nc_sid=5e03e0&mms3=true`, mimetype: 'image/jpeg', fileSha256: { $b: b64(32) }, fileLength: 100000 + Math.floor(rnd() * 900000), height: 1280, width: 960, mediaKey: { $b: b64(32) }, fileEncSha256: { $b: b64(32) }, directPath: `/v/t62.7118-24/${hex(8)}_${hex(16)}_${hex(10)}_n.enc?ccb=11-4&oh=${hex(32)}&oe=${hex(8)}&_nc_sid=5e03e0`, mediaKeyTimestamp: ts0 } } }
    }
    messages[jid].push(m)
  }
  for (const [jid, list] of Object.entries(messages)) {
    list.sort((x, y) => x.ts - y.ts)
    if (list.length) {
      const last = list.at(-1)
      chats.push({ jid, t: last.ts, unread: Math.floor(rnd() * 3), preview: (last.fromMe ? 'You: ' : '') + (last.text || '📷 Photo'), ...(jid.endsWith('@g.us') ? { subject: `Group ${jid.slice(-4)}` } : {}) })
    } else delete messages[jid]
  }
  const contacts = jids.filter((j) => !j.endsWith('@g.us')).map((j) => [j, { name: `Contact ${j.slice(2, 10)}`, notify: `Nick ${j.slice(4, 10)}` }])
  fs.mkdirSync(path.join(dataDir, dir), { recursive: true })
  fs.writeFileSync(path.join(dataDir, dir, 'store.json'), JSON.stringify({ chats, contacts, alias: [], messages, gone: [], locked: [] }))
}
fs.writeFileSync(path.join(dataDir, 'users.json'), JSON.stringify({ users }, null, 2))
const sz = fs.readdirSync(path.join(dataDir, 'accounts')).map((d) => fs.statSync(path.join(dataDir, 'accounts', d, 'store.json')).size)
console.log(`made ${ACCOUNTS} accounts, ${MESSAGES} messages each; store.json ${Math.round(sz[0] / 1048576)} MB each`)
