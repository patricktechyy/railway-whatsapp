import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { readRuntimeSettings, updateRuntimeSettings } from '../runtime-settings.js'

test('runtime settings survive reload, validate bounds and require confirmation to shorten history', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-runtime-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const file = path.join(dir, 'runtime-settings.json')
  assert.deepEqual(readRuntimeSettings(file), {})
  const timing = updateRuntimeSettings(file, {}, { idleMinutes: 20, cooldownMinutes: 45, reclaimEnabled: true }, 14)
  assert.deepEqual(timing, { idleMinutes: 20, cooldownMinutes: 45 })
  assert.throws(() => updateRuntimeSettings(file, timing, { idleMinutes: 0 }, 14), { status: 400 })
  assert.throws(() => updateRuntimeSettings(file, timing, { historyDays: 8 }, 14), { status: 409 })
  assert.deepEqual(readRuntimeSettings(file), timing)
  assert.throws(() => updateRuntimeSettings(file, timing, { historyDays: 8, confirmHistoryDays: 7 }, 14), { status: 409 })
  updateRuntimeSettings(file, timing, { historyDays: 8, confirmHistoryDays: 8 }, 14)
  assert.deepEqual(readRuntimeSettings(file), { ...timing, historyDays: 8 })
  fs.writeFileSync(file, '{')
  assert.deepEqual(readRuntimeSettings(file), { historyDays: 3650 })
})
