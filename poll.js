import crypto from 'node:crypto'

/**
 * WhatsApp polls.
 *
 * A poll goes out with a random 32-byte secret (messageContextInfo.messageSecret). Each
 * vote is a list of SHA-256 hashes of the chosen option names, encrypted with AES-256-GCM
 * under a key made from that secret, the poll's id, who made the poll and who is voting
 * (the same scheme as WhatsApp's apps and Baileys' decryptPollVote). So a vote can only be
 * read by someone who has the poll, and only counted for the person it says it's from.
 */

export const POLL_KEYS = ['pollCreationMessage', 'pollCreationMessageV2', 'pollCreationMessageV3', 'pollCreationMessageV5']
export const MAX_OPTIONS = 12

/** Bytes from whatever a secret arrives as: a Buffer, a Uint8Array, base64, { $b }, or a JSON'd Buffer. */
export function toBuf(v) {
  if (!v) return null
  if (Buffer.isBuffer(v)) return v
  if (v instanceof Uint8Array) return Buffer.from(v)
  if (typeof v === 'string') return Buffer.from(v, 'base64')
  if (typeof v.$b === 'string') return Buffer.from(v.$b, 'base64')
  if (Array.isArray(v.data)) return Buffer.from(v.data)
  if (typeof v === 'object') { const vals = Object.values(v); if (vals.every((x) => Number.isInteger(x))) return Buffer.from(vals) }
  return null
}

export const optionHash = (name) => crypto.createHash('sha256').update(Buffer.from(String(name))).digest()

function voteKey(secret, pollId, creator, voter) {
  const sign = Buffer.concat([Buffer.from(pollId), Buffer.from(creator), Buffer.from(voter), Buffer.from('Poll Vote'), Buffer.from([1])])
  const key0 = crypto.createHmac('sha256', Buffer.alloc(32)).update(toBuf(secret)).digest()
  return crypto.createHmac('sha256', key0).update(sign).digest()
}

/** PollVoteMessage { repeated bytes selectedOptions = 1 } */
function encodeVote(hashes) {
  return Buffer.concat(hashes.flatMap((h) => [Buffer.from([0x0a, h.length]), h]))
}
function readVarint(buf, i) {
  let v = 0, shift = 0, b
  do { b = buf[i++]; v += (b & 0x7f) * 2 ** shift; shift += 7 } while (b & 0x80 && i < buf.length)
  return [v, i]
}
function decodeVote(buf) {
  const out = []
  let i = 0
  while (i < buf.length) {
    let tag; [tag, i] = readVarint(buf, i)
    const field = Math.floor(tag / 8), wire = tag & 7
    if (wire === 2) { let len; [len, i] = readVarint(buf, i); if (field === 1) out.push(buf.subarray(i, i + len)); i += len }
    else if (wire === 0) [, i] = readVarint(buf, i)
    else if (wire === 1) i += 8
    else if (wire === 5) i += 4
    else break
  }
  return out
}

/** Encrypt a vote for `names` (the chosen options; none = take your vote back). */
export function encryptVote(names, { secret, pollId, creator, voter }) {
  const key = voteKey(secret, pollId, creator, voter)
  const iv = crypto.randomBytes(12)
  const c = crypto.createCipheriv('aes-256-gcm', key, iv)
  c.setAAD(Buffer.from(`${pollId}\u0000${voter}`))
  const enc = Buffer.concat([c.update(encodeVote(names.map(optionHash))), c.final(), c.getAuthTag()])
  return { encPayload: enc, encIv: iv }
}

/** The option hashes in a vote, or null if it doesn't open with these ids (wrong voter / creator). */
export function decryptVote({ encPayload, encIv }, { secret, pollId, creator, voter }) {
  try {
    const data = toBuf(encPayload), iv = toBuf(encIv)
    if (!data || !iv || data.length < 16) return null
    const d = crypto.createDecipheriv('aes-256-gcm', voteKey(secret, pollId, creator, voter), iv)
    d.setAAD(Buffer.from(`${pollId}\u0000${voter}`))
    d.setAuthTag(data.subarray(data.length - 16))
    return decodeVote(Buffer.concat([d.update(data.subarray(0, data.length - 16)), d.final()]))
  } catch { return null }
}

/**
 * Try every way the creator and voter might be written (phone number or hidden id, with or
 * without a device suffix) until the vote opens. Returns { hashes, voter } or null.
 */
export function openVote(vote, { secret, pollId, creators, voters }) {
  const variants = (list) => [...new Set(list.filter(Boolean).flatMap((j) => [j, String(j).replace(/:\d+(?=@)/, '')]))]
  for (const creator of variants(creators)) {
    for (const voter of variants(voters)) {
      const hashes = decryptVote(vote, { secret, pollId, creator, voter })
      if (hashes) return { hashes, voter }
    }
  }
  return null
}

/** Which options (by index) a list of hashes picks. */
export function pickedOptions(hashes, options) {
  const want = new Set(hashes.map((h) => Buffer.from(h).toString('hex')))
  return options.flatMap((name, i) => (want.has(optionHash(name).toString('hex')) ? [i] : []))
}
