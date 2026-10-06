// The parser lives in server/quickadd.js so tasks sent from WhatsApp are read
// exactly like ones typed here.
export { parseQuickAdd, cleanUrl, hostOf } from '../server/quickadd.js'
export type { Parsed, Link } from '../server/quickadd.js'
