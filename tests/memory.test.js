import assert from 'node:assert/strict'
import { constants } from 'node:fs'
import test from 'node:test'
import { cgroupLog, createIdleReclaimer, findMemoryCgroup, sampleCgroup, writeReclaim } from '../memory.js'

const MiB = 1048576
const eligible = { total: 400 * MiB, inactive_file: 110 * MiB, slab_reclaimable: 150 * MiB }

test('Linux sampling uses the cgroup containing this PID and reports byte and event counters', async () => {
  const files = {
    '/proc/self/cgroup': '0::/service\n',
    '/sys/fs/cgroup/service/cgroup.procs': '203\n',
    '/sys/fs/cgroup/cgroup.procs': '11\n42\n',
    '/sys/fs/cgroup/memory.current': '416309248\n',
    '/sys/fs/cgroup/memory.stat': 'file 135254016\ninactive_file 115458048\nslab_reclaimable 157751552\n',
    '/sys/fs/cgroup/memory.events': 'oom 0\noom_kill 1\n',
  }
  const read = async (file) => {
    if (!(file in files)) throw new Error('missing')
    return files[file]
  }
  const dir = await findMemoryCgroup({ read, pid: 42 })
  assert.equal(dir, '/sys/fs/cgroup')
  assert.equal(await findMemoryCgroup({ read, pid: 203 }), '/sys/fs/cgroup/service')
  assert.equal(await findMemoryCgroup({ read, pid: 4 }), null)
  assert.match(cgroupLog(await sampleCgroup(dir, read)), /container=397MiB .*inactiveFile=110MiB slabReclaimable=150MiB oom=0 oomKill=1/)
  assert.equal(await sampleCgroup('/missing', read), null)
})

test('reclaim only writes 32 MiB with swappiness zero and checks activity after opening the existing file', async () => {
  const written = []
  let closes = 0
  const open = async (file, flags) => {
    assert.equal(file, '/service/memory.reclaim')
    assert.equal(flags, constants.O_WRONLY)
    return { writeFile: async (value) => { written.push(value) }, close: async () => { closes++ } }
  }
  assert.equal(await writeReclaim('/service', () => false, open), false)
  assert.equal(await writeReclaim('/service', () => true, open), true)
  assert.deepEqual(written, ['33554432 swappiness=0'])
  assert.equal(closes, 2)
})

test('busy service, low memory, small cache and new activity all suppress reclaim', async () => {
  let idle = false
  let state = { ...eligible, total: 299 * MiB }
  let reads = 0, writes = 0
  const check = createIdleReclaimer({
    sample: async () => { reads++; return state },
    reclaim: async (permit) => { if (permit()) { writes++; return true } return false },
    isIdle: () => idle, cooldownMs: () => 30 * 60000, log: () => {},
  })
  await check()
  assert.equal(reads, 0)
  idle = true
  await check()
  state = { ...eligible, inactive_file: 127 * MiB, slab_reclaimable: 0 }
  await check()
  assert.equal(writes, 0)

  let unblock
  const later = createIdleReclaimer({
    sample: () => new Promise((resolve) => { unblock = resolve }),
    reclaim: async () => assert.fail('activity resumed before the sample finished'),
    isIdle: () => idle, cooldownMs: () => 30 * 60000,
  })
  const pending = later()
  await later() // one sample at a time
  idle = false
  unblock(eligible)
  await pending
})

test('partial reclaim observes the cooldown and a rejected write suspends the deployment', async () => {
  let now = 0
  let writes = 0
  const logs = []
  const cooldown = 30 * 60000
  const check = createIdleReclaimer({
    sample: async () => eligible,
    reclaim: async (permit) => {
      assert.ok(permit())
      throw Object.assign(new Error('test'), { code: ++writes === 1 ? 'EAGAIN' : 'EROFS' })
    },
    isIdle: () => true, cooldownMs: () => cooldown, now: () => now, log: (line) => logs.push(line),
  })
  await check()
  now = cooldown - 1
  await check()
  assert.equal(writes, 1)
  now++
  await check()
  now += cooldown
  await check()
  assert.equal(writes, 2)
  assert.match(logs[0], /result=partial.*before=400MiB after=400MiB/)
  assert.match(logs[1], /suspended.*EROFS/)
})
