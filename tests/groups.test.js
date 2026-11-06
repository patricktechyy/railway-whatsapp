import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { register } from 'node:module'
import { Store } from '../store.js'

// Group member lists live in the database with a few in memory; groups are loaded one account at a time.
register('./fixtures/stub-hooks.mjs', import.meta.url)
const { Session, serial } = await import('../session.js')

const ME = '6580000009@s.whatsapp.net'
const made = []
const tmp = () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-groups-'))
  made.push(d)
  return d
}
test.after(() => {
  for (const d of made) {
    try { fs.rmSync(d, { recursive: true, force: true }) } catch {}
  }
})
const group = (n, members = 5) => ({
  id: `1203630000000${String(n).padStart(5, '0')}@g.us`,
  subject: `Group ${n}`,
  addressingMode: 'pn',
  participants: Array.from({ length: members }, (_, i) => ({ id: `6591${String(n).padStart(3, '0')}${String(i).padStart(3, '0')}@s.whatsapp.net`, admin: i === 0 ? 'admin' : null })),
})

test('member lists come back whole, whether they are still in memory or only in the database', () => {
  const store = new Store(path.join(tmp(), 'store.json'))
  const groups = Array.from({ length: 25 }, (_, i) => group(i, 40))
  for (const g of groups) store.groups.set(g.id, g)
  assert.ok(store.groups.recent.size <= 8, 'only a few are kept in memory')
  for (const g of groups) assert.deepEqual(store.groups.get(g.id), g)
  assert.ok(store.groups.has(groups[0].id))
  assert.equal(store.groups.get('nope@g.us'), undefined)
  assert.equal(store.groups.get(undefined), undefined)
  assert.equal(store.groups.delete(groups[3].id), true)
  assert.equal(store.groups.get(groups[3].id), undefined)
  assert.equal(store.groups.has(groups[3].id), false)
  // a newer answer replaces the older one
  store.groups.set(groups[5].id, { ...groups[5], subject: 'Renamed' })
  assert.equal(store.groups.get(groups[5].id).subject, 'Renamed')
  store.close()
})

test('member lists start empty after a restart: nothing out of date is carried over', () => {
  const d = tmp()
  const first = new Store(path.join(d, 'store.json'))
  first.groups.set(group(1).id, group(1))
  first.close()
  const again = new Store(path.join(d, 'store.json'))
  assert.equal(again.groups.get(group(1).id), undefined)
  again.close()
  const third = new Store(path.join(d, 'store.json'))
  assert.equal(third.pending, false, 'opening writes nothing when there was nothing to clear')
  third.close()
})

test('something that cannot be stored does not break the account', () => {
  const store = new Store(path.join(tmp(), 'store.json'))
  const odd = { id: 'odd@g.us', big: 10n, participants: [] }
  assert.doesNotThrow(() => store.groups.set(odd.id, odd))
  assert.equal(store.groups.get(odd.id), odd, 'still there while it is in memory')
  store.close()
  assert.doesNotThrow(() => store.groups.set('late@g.us', { id: 'late@g.us' }))
})

test('idle cleanup evicts only group data that can be reloaded and expired About entries', () => {
  const s = account()
  const g = group(1)
  const odd = { id: 'odd@g.us', big: 10n, participants: [] }
  const start = Date.now()
  s.groupCache.set(g.id, g)
  s.groupCache.set(odd.id, odd)
  s.aboutCache = new Map([['old', { at: start - 3600e3 }], ['fresh', { at: start }]])
  s.trimCaches(start + 16 * 60e3, 15 * 60e3)
  assert.equal(s.groupCache.recent.has(g.id), false)
  assert.deepEqual(s.groupCache.get(g.id), g)
  assert.equal(s.groupCache.get(odd.id), odd)
  assert.deepEqual([...s.aboutCache.keys()], ['fresh'])
  s.shutdown()
})

test('memory maintenance treats recent history batches and media as busy even without viewers', () => {
  const s = account()
  const now = Date.now()
  assert.equal(s.memoryBusy(now), false)
  s.lastHistoryAt = now - 3 * 60e3
  s.metrics.historyProgress = 50
  assert.equal(s.memoryBusy(now), true)
  s.metrics.historyProgress = 100
  assert.equal(s.memoryBusy(now), false)
  s.mediaJobs = new Map([['download', {}]])
  assert.equal(s.memoryBusy(now), true)
  s.shutdown()
})
test('memory: a hundred big groups cost far less in the cache than in a Map', () => {
  const store = new Store(path.join(tmp(), 'store.json'))
  const groups = Array.from({ length: 100 }, (_, i) => group(i, 400))
  global.gc?.()
  const before = process.memoryUsage().heapUsed
  for (const g of groups) store.groups.set(g.id, structuredClone(g))
  global.gc?.()
  const cacheCost = process.memoryUsage().heapUsed - before
  const map = new Map()
  global.gc?.()
  const before2 = process.memoryUsage().heapUsed
  for (const g of groups) map.set(g.id, structuredClone(g))
  global.gc?.()
  const mapCost = process.memoryUsage().heapUsed - before2
  // (only meaningful when the test is run with --expose-gc; otherwise it just checks nothing broke)
  if (global.gc) assert.ok(cacheCost < mapCost / 3, `cache ${cacheCost} vs map ${mapCost}`)
  assert.equal(store.groups.get(groups[50].id).participants.length, 400)
  store.close()
})

// ---------------------------------------------------------------- the session
function account() {
  const dir = tmp()
  const s = new Session({ key: 'anna', label: 'Anna', dir })
  s.me = { jid: ME, lid: null, phone: '+6580000009', name: 'Anna' }
  s.status = 'connected'
  return s
}

test('groups are loaded one account at a time, and each account gets its groups, names and member lists', async () => {
  const accounts = [account(), account(), account()]
  let running = 0
  let most = 0
  const order = []
  accounts.forEach((s, i) => {
    s.sock = {
      groupFetchAllParticipating: async () => {
        running++
        most = Math.max(most, running)
        order.push(i)
        await new Promise((r) => setTimeout(r, 25))
        running--
        return Object.fromEntries([group(i * 10 + 1, 12), group(i * 10 + 2, 12)].map((g) => [g.id, g]))
      },
    }
  })
  await Promise.all(accounts.map((s) => s.loadGroups(s.sock)))
  assert.equal(most, 1)
  assert.deepEqual(order, [0, 1, 2])
  accounts.forEach((s, i) => {
    const g = group(i * 10 + 1, 12)
    assert.deepEqual(s.groupCache.get(g.id), g)
    assert.equal(s.store.chats.get(g.id).subject, `Group ${i * 10 + 1}`)
    s.shutdown()
  })
})

test('a load that was queued for a socket that has since been replaced (or an account removed) is skipped', async () => {
  const s = account()
  let asked = 0
  const old = { groupFetchAllParticipating: async () => { asked++; return {} } }
  s.sock = { groupFetchAllParticipating: async () => { asked++; return {} } }
  await s.loadGroups(old)
  assert.equal(asked, 0)
  s.stopped = true
  await s.loadGroups(s.sock)
  assert.equal(asked, 0)
  s.shutdown()
})

test('an old socket cannot publish its group list after a reconnect', async () => {
  const s = account()
  const g = group(1)
  let finish, started
  const fetching = new Promise((resolve) => { started = resolve })
  const old = { groupFetchAllParticipating: () => new Promise((resolve) => { finish = resolve; started() }) }
  s.sock = old
  const pending = s.loadGroups(old)
  await fetching
  s.sock = {}
  finish({ [g.id]: g })
  await pending
  assert.equal(s.groupCache.has(g.id), false)
  s.shutdown()
})

test('one failing group load does not stop the next account', async () => {
  const bad = account()
  const good = account()
  bad.sock = { groupFetchAllParticipating: async () => { throw new Error('rate limited') } }
  good.sock = { groupFetchAllParticipating: async () => ({ [group(7).id]: group(7) }) }
  await Promise.all([bad.loadGroups(bad.sock), good.loadGroups(good.sock)])
  assert.equal(good.groupCache.get(group(7).id).subject, 'Group 7')
  bad.shutdown()
  good.shutdown()
})

test('the people who get a group message are worked out once per member list, and again when it changes', () => {
  const s = account()
  const g = group(1, 6)
  g.participants.push({ id: '11111@lid', phoneNumber: '6599999999@s.whatsapp.net' })
  g.participants.push({ id: ME })
  s.groupCache.set(g.id, g)
  let links = 0
  const link = s.store.link.bind(s.store)
  s.store.link = (...a) => { links++; return link(...a) }

  const first = s.groupRecipients(g.id)
  assert.equal(first.size, 7) // everybody but me
  assert.ok(first.has('6599999999@s.whatsapp.net'))
  const linksAfterFirst = links
  assert.ok(linksAfterFirst >= 1)
  assert.equal(s.groupRecipients(g.id), first, 'the same answer, not worked out again')
  assert.equal(links, linksAfterFirst)

  // a new member list (WhatsApp sent an update) is counted afresh
  s.groupCache.set(g.id, { ...g, participants: g.participants.slice(0, 3) })
  const second = s.groupRecipients(g.id)
  assert.notEqual(second, first)
  assert.equal(second.size, 3)
  assert.equal(s.groupRecipients('unknown@g.us'), null)
  s.shutdown()
})

test('group recipients are recalculated when an existing LID mapping changes', () => {
  const s = account()
  const g = { ...group(1), participants: [{ id: '11111@lid' }] }
  s.groupCache.set(g.id, g)
  s.store.link('11111@lid', '6599999999@s.whatsapp.net')
  assert.deepEqual([...s.groupRecipients(g.id)], ['6599999999@s.whatsapp.net'])
  s.store.link('11111@lid', '6599999998@s.whatsapp.net')
  assert.deepEqual([...s.groupRecipients(g.id)], ['6599999998@s.whatsapp.net'])
  s.shutdown()
})

test('serial() runs jobs one by one in order and a failure does not stop the rest', async () => {
  const run = serial()
  const log = []
  const job = (n, ms, fail) => run(async () => { log.push(`+${n}`); await new Promise((r) => setTimeout(r, ms)); log.push(`-${n}`); if (fail) throw new Error(n); return n })
  const r = await Promise.allSettled([job('a', 20), job('b', 1, true), job('c', 1)])
  assert.deepEqual(log, ['+a', '-a', '+b', '-b', '+c', '-c'])
  assert.deepEqual(r.map((x) => x.status), ['fulfilled', 'rejected', 'fulfilled'])
})
