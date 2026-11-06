// node --import ./preload.mjs server.js : a pretend WhatsApp that is "connected" at once, serves FAKE_MEDIA_MB of
// media for any download, and swallows whatever is sent (counting it).
import { register } from 'node:module'
import { Readable } from 'node:stream'
import fs from 'node:fs'
register(new URL('./stub-hooks.mjs', import.meta.url))

const MB = Number(process.env.FAKE_MEDIA_MB || 60)
const CHUNK = 65536
const total = MB * 1048576
const chunk = (i) => Buffer.alloc(CHUNK, i & 255)
globalThis.__fake = { sent: [], downloads: 0 }

function mediaStream() {
  let sent = 0
  let i = 0
  return new Readable({
    read() {
      if (sent >= total) return this.push(null)
      sent += CHUNK
      this.push(chunk(i++))
    },
  })
}

globalThis.__baileys = {
  useMultiFileAuthState: async () => ({ state: { creds: { registered: true, me: { id: '6580000009:1@s.whatsapp.net' } } }, saveCreds() {} }),
  downloadMediaMessage: async (raw, type) => {
    globalThis.__fake.downloads++
    if (type === 'stream') return mediaStream()
    const parts = []
    for await (const c of mediaStream()) parts.push(c)
    return Buffer.concat(parts)
  },
  makeWASocket: () => {
    const handlers = {}
    let n = 0
    const sock = {
      user: { id: '6580000009:1@s.whatsapp.net' },
      ev: { on: (name, fn) => { (handlers[name] ||= []).push(fn) } },
      sendPresenceUpdate: async () => {},
      groupFetchAllParticipating: async () => ({}),
      end() {},
      sendMessage: async (to, content) => {
        const media = content.document || content.image || content.audio || content.video
        let bytes = 0
        if (media) {
          if (Buffer.isBuffer(media)) bytes = media.length
          else if (media.url) for await (const c of fs.createReadStream(media.url)) bytes += c.length
        }
        globalThis.__fake.sent.push({ to, bytes })
        return { key: { remoteJid: to, id: `FAKE${++n}`, fromMe: true }, messageTimestamp: Math.floor(Date.now() / 1000), message: { conversation: 'sent' } }
      },
    }
    setTimeout(() => (handlers['connection.update'] || []).forEach((f) => f({ connection: 'open' })), 100)
    return sock
  },
}
