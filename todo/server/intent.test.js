import test from 'node:test'
import assert from 'node:assert/strict'
import { model, listNumber, snoozePhrase, findTask, onlyWhen, words } from './intent.js'

// phrasings the model was never trained on
const UNSEEN = {
  today: ['what do i have to do today', 'whats due today?', 'show me my list', 'what tasks do i have', 'got anything today?', 'whats pending'],
  tomorrow: ['anything tomorrow?', 'tmrw what do i have', 'whats for tomorrow', 'what is on for tomorrow'],
  upcoming: ['what deadlines are coming', 'anything this week?', 'whats due this week', 'anything due in the next few days'],
  overdue: ['did i miss anything', 'what is overdue', 'anything im late on', 'which tasks did i miss'],
  done: ['finished biology', 'done with the chem ws', 'just did the essay', 'i submitted the lab report', 'done!', 'finished it', 'completed number 4', 'handed in the form', 'finishd the reading', 'yep finished', 'did the chem homework', 'done number 3'],
  start: ['starting maths now', 'im working on the essay', 'start number 1', 'starting chem', 'working on bio now'],
  snooze: ['remind me in 2 hours', 'later!', 'not right now', 'give me 10 min', 'ask me after dinner', 'im busy, later', 'later please', 'give me 45 min'],
  move: ['move bio to tomorrow', 'push the essay to next monday', 'reschedule chem to friday', 'do maths tomorrow instead', 'push bio to monday', 'push all to tomorrow'],
  delete: ['delete number 2', 'remove the gym one', 'cancel piano', 'delete the essay task', 'delete the dentist task', 'remove number 4'],
  step: ['finished the first step', 'next step pls', 'did one step'],
  study: ['what do i study today', 'revision plan pls', 'which topics today', 'what should i revise today'],
  exams: ['when is my next exam', 'exam dates', 'when is the physics paper', 'my exam schedule'],
  help: ['how do i use you', 'what commands are there', 'what can you do for me', 'what can i ask you'],
  add: ['buy eggs tomorrow', 'need to email the teacher', 'finish chem ws by thursday', 'call grandma sunday', 'bring umbrella tomorrow', 'pick up mum at 6pm', 'print notes', 'buy shampoo', 'chem quiz on thursday', 'pay for the excursion', 'need to finish the essay by friday'],
  chat: ['thanks!', 'ok cool', 'thank u', 'good morning buddy', 'haha nice', 'okie', 'thanks buddy', 'okay thanks'],
}

test('understands phrasings it was never shown (≥ 93%)', () => {
  const m = model()
  let ok = 0, n = 0
  const miss = []
  for (const [want, list] of Object.entries(UNSEEN)) for (const t of list) {
    n++
    const r = m.classify(t)
    if (r.intent === want) ok++
    else miss.push(`${t} → ${r.intent} (${r.p.toFixed(2)}), wanted ${want}`)
  }
  assert.ok(ok / n >= 0.93, `${ok}/${n}\n${miss.join('\n')}`)
})

test('fast and light', () => {
  const m = model()
  const t0 = performance.now()
  for (let i = 0; i < 500; i++) m.classify('finished the biology homework already')
  assert.ok((performance.now() - t0) / 500 < 2, 'under 2 ms a message')
})

test('typos and short forms still land', () => {
  const m = model()
  assert.equal(m.classify('snoze 1 hr').intent, 'snooze')
  assert.equal(m.classify('whats on tommorow').intent, 'tomorrow')
  assert.equal(m.classify('finsihed bio hw').intent, 'done')
  assert.deepEqual(words('done w/ hw tmr 5pm'), ['done', 'w', 'homework', 'tomorrow', '_time_'])
})

test('list numbers, not times or lengths', () => {
  assert.equal(listNumber('finished number 2'), 2)
  assert.equal(listNumber('done #3'), 3)
  assert.equal(listNumber('move 2 to tomorrow'), 2)
  assert.equal(listNumber('remind me in 2 hours'), null)
  assert.equal(listNumber('ping me at 5pm'), null)
  assert.equal(listNumber('give me 10 min'), null)
  assert.equal(listNumber('finished the bio homework'), null)
})

test('the when in a snooze', () => {
  assert.equal(snoozePhrase('remind me in 2 hours'), '2h')
  assert.equal(snoozePhrase('give me 45 min'), '45m')
  assert.equal(snoozePhrase('give me an hour'), '1h')
  assert.equal(snoozePhrase('half an hour pls'), '30m')
  assert.equal(snoozePhrase('busy now remind me at 5pm'), '5pm')
  assert.equal(snoozePhrase('ask me after dinner'), 'tonight')
  assert.equal(snoozePhrase('not now'), 'later')
  assert.ok(onlyWhen('later') && onlyWhen('again in 2 hours') && onlyWhen('at 5pm') && onlyWhen('tonight'))
  assert.ok(!onlyWhen('to call mum at 8pm') && !onlyWhen('in 2 hours to buy milk'))
})

test('finds the task by name, short forms and typos included', () => {
  const tasks = [
    { id: 'a', title: 'Biology homework' }, { id: 'b', title: 'Chemistry worksheet 3' }, { id: 'c', title: 'Maths: algebra exercise' },
    { id: 'd', title: 'Water the plants' }, { id: 'e', title: 'English essay draft' }, { id: 'f', title: 'Essay outline for history' },
  ]
  assert.equal(findTask('finished the bio hw', tasks).task?.id, 'a')
  assert.equal(findTask('done with chem ws', tasks).task?.id, 'b')
  assert.equal(findTask('did maths', tasks).task?.id, 'c')
  assert.equal(findTask('watered the plnts', tasks).task?.id, 'd')
  assert.deepEqual(findTask('finished the essay', tasks).many?.map((t) => t.id).sort(), ['e', 'f'], 'two essays: ask which')
  assert.equal(findTask('english essay done', tasks).task?.id, 'e')
  assert.ok(findTask('finished the piano', tasks).none)
  assert.ok(findTask('just finished it', tasks).empty, 'no name: the one we were talking about')
})
