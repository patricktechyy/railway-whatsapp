import { constants } from 'node:fs'
import { open, readFile } from 'node:fs/promises'
import path from 'node:path'

const MiB = 1048576
const reclaimBytes = 32 * MiB
const number = (value) => /^\d+$/.test(value ?? '') && Number.isSafeInteger(Number(value)) ? Number(value) : undefined
const counters = (text) => Object.fromEntries(text.trim().split('\n').map((line) => {
  const [key, value] = line.trim().split(/\s+/)
  return [key, number(value)]
}))

/** Only use a cgroup that lists this process as a direct member, including private cgroup mounts. */
export async function findMemoryCgroup({ read = readFile, pid = process.pid, mount = '/sys/fs/cgroup' } = {}) {
  try {
    const line = (await read('/proc/self/cgroup', 'utf8')).split('\n').find((x) => x.startsWith('0::/'))
    if (!line) return null
    const relative = line.slice(4)
    if (relative.split('/').includes('..')) return null
    for (const dir of new Set([path.posix.join(mount, relative), mount])) {
      const procs = await read(path.posix.join(dir, 'cgroup.procs'), 'utf8').catch(() => '')
      if (procs.split(/\s+/).includes(String(pid))) return dir
    }
  } catch {}
  return null
}

export async function sampleCgroup(dir, read = readFile) {
  if (!dir) return null
  try {
    const get = (name) => read(path.posix.join(dir, name), 'utf8')
    const [current, stat, events] = await Promise.all([
      get('memory.current'), get('memory.stat'), get('memory.events').catch(() => ''),
    ])
    const total = number(current.trim())
    if (total === undefined) return null
    return { total, ...counters(stat), events: counters(events) }
  } catch {
    return null
  }
}

const mb = (value) => value === undefined ? '?' : Math.round(value / MiB)

export function cgroupLog(m) {
  if (!m) return ''
  return ` container=${mb(m.total)}MiB anon=${mb(m.anon)}MiB file=${mb(m.file)}MiB inactiveFile=${mb(m.inactive_file)}MiB slabReclaimable=${mb(m.slab_reclaimable)}MiB oom=${m.events.oom ?? '?'} oomKill=${m.events.oom_kill ?? '?'} fileRefaults=${m.workingset_refault_file ?? '?'}`
}

/** Open without creating a file and recheck activity after the async open, just before the write. */
export async function writeReclaim(dir, permitWrite, openFile = open) {
  const fd = await openFile(path.posix.join(dir, 'memory.reclaim'), constants.O_WRONLY)
  try {
    if (!permitWrite()) return false
    await fd.writeFile(`${reclaimBytes} swappiness=0`)
    return true
  } finally {
    await fd.close()
  }
}

export function createIdleReclaimer({ sample, reclaim, isIdle, cooldownMs, now = Date.now, log = console.log }) {
  let lastAttempt = -Infinity
  let busy = false
  let suspended = false
  const ready = () => !suspended && isIdle() && now() - lastAttempt >= cooldownMs()

  return async function check() {
    if (busy || !ready()) return
    busy = true
    try {
      const before = await sample()
      if (!before || before.total < 300 * MiB ||
          (before.inactive_file ?? 0) + (before.slab_reclaimable ?? 0) < 128 * MiB || !ready()) return
      let result = 'ok'
      try {
        const wrote = await reclaim(() => {
          if (!ready()) return false
          lastAttempt = now()
          return true
        })
        if (!wrote) return
      } catch (e) {
        // Linux can return EAGAIN after reclaiming some pages. Observe the actual result and respect the cooldown.
        if (e.code !== 'EAGAIN') {
          suspended = true
          log(`[mem-reclaim] suspended for this deployment (${e.code || 'write failed'})`)
          return
        }
        result = 'partial'
      }
      const after = await sample()
      log(`[mem-reclaim] result=${result} requested=32MiB before=${mb(before.total)}MiB after=${mb(after?.total)}MiB`)
    } finally {
      busy = false
    }
  }
}
