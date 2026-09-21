// Runs once during the Docker build, right after `npm install`.
//
// Baileys hard-codes `platform: ...Platform.WEB` in the login it sends to
// WhatsApp. Combined with the desktop identity (which we use because it gets
// full chat history) that says "web browser" and "Mac desktop app" at once,
// and WhatsApp hangs up on it. This changes that single line so the app picks
// the platform at runtime (MACOS for desktop, WEB for WA_BROWSER=chrome).
//
// It only touches an object key named `platform:`, never comparisons, and if
// it can't find the line it says so and leaves Baileys untouched.
import fs from 'node:fs'
import path from 'node:path'

const root = path.resolve(process.argv[2] || 'node_modules/baileys')
let version = '?'
try {
  version = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version
} catch {}
console.log(`[patch] baileys ${version}`)

const files = []
const walk = (dir) => {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) walk(p)
    else if (/\.(c|m)?js$/.test(e.name)) files.push(p)
  }
}
try {
  walk(path.join(root, 'lib'))
} catch {
  console.log('[patch] no lib/ folder found; nothing patched')
  process.exit(0)
}

const re = /(platform\s*:\s*)((?:[\w$]+\.)*ClientPayload\.UserAgent\.Platform)\.WEB\b/g
let patched = 0
for (const f of files) {
  const src = fs.readFileSync(f, 'utf8')
  if (src.includes('globalThis.__WA_PLATFORM__')) {
    patched++ // already done (e.g. a cached layer); count it, don't re-patch
    console.log(`[patch] already patched: ${path.relative(root, f)}`)
    continue
  }
  if (!src.includes('UserAgent.Platform.WEB')) continue
  const out = src.replace(re, (_, key, enumPath) => {
    patched++
    return `${key}(${enumPath}[globalThis.__WA_PLATFORM__ || 'WEB'] ?? ${enumPath}.WEB)`
  })
  if (out !== src) {
    fs.writeFileSync(f, out)
    console.log(`[patch] platform is now chosen at runtime in ${path.relative(root, f)}`)
  }
}
fs.writeFileSync(path.join(root, '.wa-platform-patch'), String(patched))
if (!patched) console.log('[patch] WARNING: platform line not found; Baileys left as-is (reports WEB)')
