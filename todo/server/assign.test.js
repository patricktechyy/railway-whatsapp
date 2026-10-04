import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Store } from './store.js'
import { Assignments, progressOf } from './assign.js'

const dir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'assign-'))
const from = { by: 'admin', name: 'Boss', assignment: 'a1' }

test('an assigned task carries who it is from; a normal request cannot set that', () => {
  const s = new Store(dir())
  const t = s.addTask('zef', { title: 'Bring guitar', due: '2026-10-10', time: '16:00', remind: 0 }, { from })
  assert.deepEqual(t.from, from)
  assert.equal(t.remind, 0)
  const forged = s.addTask('zef', { title: 'Fake', from })
  assert.equal(forged.from, undefined)
  s.updateTask('zef', forged.id, { from })
  assert.equal(s.snapshot('zef').tasks.find((x) => x.id === forged.id).from, undefined)
})

test('checkTask validates without saving', () => {
  const s = new Store(dir())
  assert.throws(() => s.checkTask({ title: '' }), /needs a title/)
  assert.throws(() => s.checkTask({ title: 'x', due: '2026-10-10', time: '9am' }), /Time must look like/)
  assert.equal(s.checkTask({ title: ' Hi ', subtasks: [{ title: 'one' }] }).subtasks.length, 1)
  assert.deepEqual(s.usernames(), [])
})

test('progress follows the newest round of a repeating assignment; withdraw keeps finished ones', () => {
  const s = new Store(dir())
  const t = s.addTask('zef', { title: 'Water plants', due: '2026-10-05', repeat: { freq: 'day', interval: 1 } }, { from })
  assert.equal(progressOf(s.tasksFrom('zef', 'a1')).status, 'todo')
  s.updateTask('zef', t.id, { status: 'done' }) // makes tomorrow's copy, which is from the same assignment
  const all = s.tasksFrom('zef', 'a1')
  assert.equal(all.length, 2)
  const pr = progressOf(all)
  assert.equal(pr.status, 'todo')
  assert.equal(pr.rounds, 1)
  assert.equal(s.withdrawAssignment('zef', 'a1'), 1) // only the open copy goes
  assert.equal(s.tasksFrom('zef', 'a1').length, 1)
  assert.equal(progressOf(s.tasksFrom('zef', 'a1')).status, 'done')
  assert.equal(progressOf([]).status, 'removed')
})

test('assignment records are saved and capped', () => {
  const d = dir()
  const a = new Assignments(d)
  a.add({ id: 'x', title: 'One', to: ['zef'] })
  assert.equal(new Assignments(d).get('x').title, 'One')
  assert.equal(a.remove('x'), true)
  assert.equal(new Assignments(d).all().length, 0)
})
