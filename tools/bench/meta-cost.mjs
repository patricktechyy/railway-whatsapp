import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const { Store } = await import(new URL('../../store.js', import.meta.url).href)
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'metacost-'))
const s = new Store(path.join(dir, 'store.json'))
const t = Math.floor(Date.now() / 1000)
for (let i = 0; i < 800; i++) s.chats.set(`65${80000000 + i}@s.whatsapp.net`, { jid: `65${80000000 + i}@s.whatsapp.net`, t: t - i, unread: i % 3, preview: 'a preview of a message '.repeat(4) })
for (let i = 0; i < 5000; i++) s.contacts.set(`65${70000000 + i}@s.whatsapp.net`, { name: `Contact number ${i}`, notify: `Nick ${i}`, verified: i % 20 ? undefined : `Shop ${i}` })
for (let i = 0; i < 2000; i++) s.alias.set(`9${String(i).padStart(10, '0')}@lid`, `65${70000000 + i}@s.whatsapp.net`)
for (let i = 0; i < 3000; i++) s.gone.add(`3EB0${String(i).padStart(18, '0')}`)
const heapBefore = process.memoryUsage().heapUsed
const sizes = []
const t0 = performance.now()
for (let i = 0; i < 100; i++) { s.dirty = true; s.flush(); sizes.push(fs.statSync(s.metaFile).size) }
const ms = (performance.now() - t0) / 100
console.log(`meta file ${(sizes[0] / 1024).toFixed(0)} KB; one save takes ${ms.toFixed(1)} ms; 100 saves allocated about ${(((process.memoryUsage().heapUsed - heapBefore) / 1048576) | 0)} MB net (garbage is collected)`)
// what the maps themselves hold in memory
global.gc?.()
console.log(`maps in memory: chats ${s.chats.size}, contacts ${s.contacts.size}, alias ${s.alias.size}, gone ${s.gone.size}`)
const m0 = process.memoryUsage().heapUsed
const copy = { chats: [...s.chats.values()].map((x) => ({ ...x })), contacts: [...s.contacts].map(([k, v]) => [k, { ...v }]) }
console.log(`a second copy of chats+contacts would add about ${(((process.memoryUsage().heapUsed - m0) / 1024) | 0)} KB`)
s.close()
