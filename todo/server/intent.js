/**
 * Buddy's ear: a tiny model that works out what a loosely worded message means
 * ("finished the bio thing" → done, "push maths to friday" → move), for messages
 * the exact commands don't catch.
 *
 * It's a naive Bayes classifier over words, word pairs and the letter-triples inside
 * words (so "tommorow" and "snoze" still land), trained on the examples below when the
 * server starts. No downloads, no outside service: a few milliseconds and a few hundred
 * KB of memory. It only picks what someone wants to do; the details (which task, what
 * time, which day) are read by plain code afterwards.
 */

// ----------------------------------------------------------------- examples
// Each intent gets phrasings people actually send. To teach Buddy something new, add a
// line here (and a check in intent.test.js).
export const EXAMPLES = {
  today: [
    'what do i have today', 'whats on today', 'anything due today', 'show my tasks', 'what is on my list',
    'what should i do now', 'my todo list', 'whats left for today', 'remaining tasks', 'tasks pls',
    'what do i need to do', 'any homework today', 'what have i got', 'list my stuff', 'what is due',
    'show me today', 'what else do i have', 'what do i still need to do today', 'apa tugas hari ini', 'hari ini ada apa',
    'whats my plan today', 'show todo', 'anything i need to do', 'what is left', 'what are my tasks',
  ],
  tomorrow: [
    'what is due tomorrow', 'anything for tmr', 'what do i have tomorrow', 'besok ada apa', 'tomorrows tasks',
    'plans for tomorrow', 'what about tomorrow', 'show tomorrow', 'anything due tomorrow', 'tmr got what',
    'what do i need to do tomorrow', 'list for tomorrow', 'whats on tomorrow', 'tomorrow got anything',
  ],
  upcoming: [
    'what is coming up this week', 'next few days', 'anything due this week', 'upcoming deadlines', 'what is due soon',
    'whats coming up', 'show the week', 'what do i have this week', 'deadlines this week', 'anything coming up',
    'what is due next week', 'week ahead',
  ],
  overdue: [
    'what did i miss', 'anything overdue', 'what is late', 'what am i behind on', 'missed deadlines',
    'what did i forget', 'overdue stuff', 'anything i missed', 'what is past due', 'which ones are late',
  ],
  done: [
    'finished the bio homework', 'done with maths', 'i did the essay', 'completed lab report', 'just finished it',
    'that is done', 'ok done', 'submitted the assignment', 'handed in my essay', 'sudah selesai',
    'finished number 2', 'ticked off the reading', 'got it done', 'all done with chem worksheet', 'already did it',
    'i finished it', 'done already', 'did number 3', 'mark the essay as done', 'i have done the physics questions',
    'completed', 'finally done with the project', 'sent the email already', 'just submitted it', 'finished 1',
    'i am done with the reading', 'did it', 'done and dusted', 'check off the laundry', 'cleared the worksheet',
    'selesai tugas fisika', 'udah kelar', 'wrapped up the slides', 'i did it already', 'yes done',
    'this one is done', 'the reading is done', 'maths is done', 'that task is complete', 'its finished',
  ],
  start: [
    'starting on the essay now', 'working on maths', 'gonna start the lab report', 'beginning physics now', 'on it',
    'let me start number 3', 'mulai kerjain', 'starting now', 'i am starting the reading', 'doing it now',
    'working on it', 'about to start chem', 'i will start the slides now', 'begin number 2', 'started the worksheet',
  ],
  snooze: [
    'remind me later', 'not now', 'later pls', 'give me an hour', 'remind me again in 30 min',
    'push it back an hour', 'snooze for 2 hours', 'ask me again tonight', 'nanti aja', 'in a bit',
    'cant right now', 'busy now remind me at 5pm', 'later', 'remind me in an hour', 'not yet',
    'ask again later', 'give me 20 minutes', 'ping me at 8pm', 'hold on remind me in 15 min', 'nudge me again later',
    'busy rn', 'after dinner', 'one hour later', 'remind me again tonight', 'snooze',
  ],
  move: [
    'move it to tomorrow', 'push maths to friday', 'do it tomorrow instead', 'postpone the essay', 'reschedule bio to next week',
    'move everything to tomorrow', 'i will do it tomorrow', 'cant today do it tomorrow', 'pindah ke besok', 'move the reading to monday',
    'shift chem to saturday', 'push everything to tomorrow', 'bump it to next week', 'move number 2 to tomorrow', 'delay the slides to sunday',
    'change the essay to thursday', 'do the lab report on wednesday instead', 'push it to tmr', 'move all to tomorrow', 'postpone',
  ],
  delete: [
    'delete the gym task', 'remove number 3', 'cancel the essay', 'dont need that anymore', 'never mind that one',
    'scrap the reading', 'hapus', 'delete it', 'remove it from my list', 'get rid of the laundry task',
    'cancel number 2', 'that one is not needed', 'delete number 1', 'take the piano off my list', 'remove the meeting',
  ],
  step: [
    'next step', 'done with the first step', 'ticked a step', 'finished one part', 'one step done',
    'did the first part', 'finished a step', 'step done', 'next part', 'part one done',
  ],
  study: [
    'what should i study today', 'study plan', 'what topics today', 'revision plan', 'what to revise',
    'what do i revise', 'study what', 'what to study', 'show study plan', 'my revision today',
    'which topics should i do', 'belajar apa', 'study schedule',
  ],
  exams: [
    'when are my exams', 'exam timetable', 'next exam', 'when is the maths paper', 'test schedule',
    'jadwal ujian', 'when is my chem test', 'exams coming up', 'what exams do i have', 'paper dates',
    'any tests coming up', 'which tests are next', 'when are the tests', 'test dates',
  ],
  help: [
    'what can you do', 'how does this work', 'commands', 'help me use this', 'what can i say',
    'how do i add a task', 'how to use', 'what do i type', 'help pls', 'instructions',
  ],
  add: [
    'buy milk tomorrow', 'need to print the handout', 'gotta call mum at 8pm', 'essay due friday', 'finish lab report by thursday',
    'submit the form', 'pick up laundry', 'read chapter 5 tonight', 'math worksheet due monday', 'remember to bring pe kit',
    'have to return library book', 'book dentist appointment', 'practice piano 30 min', 'study for chem test friday', 'finish the essay draft by sunday',
    'email mr tan about the project', 'pay phone bill', 'clean my room saturday', 'buy a birthday gift for sarah', 'water the plants',
    'i need to finish the slides by monday', 'dont forget to bring the charger', 'revise algebra on wednesday', 'go to the bank tomorrow 10am', 'make notes for history',
    'beli susu', 'kerjain pr matematika besok', 'renew passport', 'send the photos to dad', 'prepare presentation for tuesday',
    'call the plumber', 'finish physics homework tonight', 'hand in permission slip', 'collect parcel', 'write cover letter',
    'buy bread tomorrow', 'bring the camera tomorrow', 'wash the car tomorrow', 'pack bag tomorrow morning', 'meet jun tomorrow at 3pm',
    'assignment due next tuesday', 'quiz next friday', 'buy stamps', 'bring lunch money tomorrow', 'fix bike next week',
  ],
  chat: [
    'thanks', 'thank you', 'ok', 'okay', 'cool', 'nice', 'lol', 'haha', 'good morning', 'good night',
    'you are the best', 'great', 'makasih', 'sip', 'ok noted', 'alright', 'nvm', 'nice one', 'thx buddy', 'hello there',
    'how are you', 'love you', 'wow', 'sure', 'k',
  ],
}

// ---------------------------------------------------------------- features
const SYN = {
  tmr: 'tomorrow', tmrw: 'tomorrow', tomorow: 'tomorrow', tommorow: 'tomorrow', besok: 'tomorrow',
  pls: 'please', plz: 'please', rn: 'now', u: 'you', ur: 'your', dont: 'do not', cant: 'can not', wont: 'will not',
  hw: 'homework', pr: 'homework', tq: 'thanks', thx: 'thanks', ty: 'thanks', makasih: 'thanks',
}
/** Lower case, words only, a few common shortenings spelled out, numbers and times as kinds. */
export function words(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[’']/g, '')
    .replace(/\b\d{1,2}(:\d{2})?\s*(am|pm)\b|\b\d{1,2}:\d{2}\b/g, ' _time_ ')
    .replace(/\b\d{1,3}\s*(m|min|mins|minutes?|h|hr|hrs|hours?|d|days?)\b/g, ' _dur_ ')
    .replace(/#?\b\d{1,2}\b/g, ' _num_ ')
    .split(/[^\p{L}\p{N}_]+/u)
    .filter(Boolean)
    .flatMap((w) => (SYN[w] || w).split(' '))
}
function features(text) {
  const ws = words(text)
  const f = new Map()
  const add = (k, v) => f.set(k, (f.get(k) || 0) + v)
  if (!ws.length) add('<empty>', 1)
  ws.forEach((w, i) => {
    add(`w:${w}`, 1)
    if (i) add(`b:${ws[i - 1]}_${w}`, 1)
    if (w.length > 3 && !w.startsWith('_')) {
      const p = `^${w}$`
      for (let j = 0; j + 3 <= p.length; j++) add(`c:${p.slice(j, j + 3)}`, 0.25)
    }
  })
  add(`len:${Math.min(ws.length, 6)}`, 0.5) // short messages lean to chat / commands
  return f
}

// ------------------------------------------------------------------- model
export class IntentModel {
  constructor(examples = EXAMPLES, alpha = 0.3) {
    this.alpha = alpha
    this.labels = Object.keys(examples)
    this.counts = new Map() // label -> Map(feature -> weight)
    this.totals = new Map()
    this.vocab = new Set()
    const n = Object.values(examples).reduce((a, l) => a + l.length, 0)
    this.prior = new Map()
    for (const label of this.labels) {
      const c = new Map()
      let total = 0
      for (const ex of examples[label]) {
        for (const [k, v] of features(ex)) { c.set(k, (c.get(k) || 0) + v); total += v; this.vocab.add(k) }
      }
      this.counts.set(label, c)
      this.totals.set(label, total)
      // flatten the priors: an intent with more examples shouldn't win ties by size alone
      this.prior.set(label, Math.log((examples[label].length + n / this.labels.length) / (2 * n)))
    }
  }
  /** { intent, p, ranked: [[label, p], …] } — p is how sure it is (0–1). */
  classify(text) {
    const f = features(text)
    const V = this.vocab.size
    const scores = this.labels.map((label) => {
      const c = this.counts.get(label), total = this.totals.get(label)
      let s = this.prior.get(label)
      for (const [k, v] of f) {
        if (!this.vocab.has(k)) continue // never seen anywhere: says nothing
        s += v * Math.log(((c.get(k) || 0) + this.alpha) / (total + this.alpha * V))
      }
      return [label, s]
    })
    const max = Math.max(...scores.map(([, s]) => s))
    const exp = scores.map(([l, s]) => [l, Math.exp(s - max)])
    const sum = exp.reduce((a, [, e]) => a + e, 0)
    const ranked = exp.map(([l, e]) => [l, e / sum]).sort((a, b) => b[1] - a[1])
    return { intent: ranked[0][0], p: ranked[0][1], ranked }
  }
}

let shared = null
export const model = () => (shared ||= new IntentModel())

// ------------------------------------------------------------ the details
/** "number 2", "#2", "no 2", or a lone small number that isn't a time or a length. */
export function listNumber(text) {
  const t = String(text || '').toLowerCase()
  let m = t.match(/(?:#|\bno\.?\s*|\bnumber\s*|\bnomor\s*|\bnum\s*)(\d{1,2})\b/)
  if (m) return Number(m[1])
  m = t.match(/(?:^|\s)(\d{1,2})(?=\s*$|\s+(?!(?:m|min|mins|minutes?|h|hr|hrs|hours?|d|days?|am|pm|:)\b))/)
  if (m && !/\d\s*(am|pm)|\d:\d/.test(t)) return Number(m[1])
  return null
}

/** Is this just a when ("later", "again in 2 hours", "at 5pm", "tonight"), with nothing else in it? */
export function onlyWhen(text) {
  const left = String(text || '').toLowerCase()
    .replace(/\b\d{1,3}\s*(m|min|mins|minutes?|h|hr|hrs|hours?|d|days?)\b/g, ' ')
    .replace(/\b\d{1,2}(:\d{2})?\s*(am|pm)\b|\b\d{1,2}:\d{2}\b/g, ' ')
    .replace(/\b(half an? hour|an? hour|one hour|an? (couple|few) (of )?hours|tonight|this evening|after dinner|tomorrow|tmr|tmrw|besok|later|again|in|at|for|after|please|pls|a bit|bit|nanti|aja)\b/g, ' ')
    .replace(/[^\p{L}\p{N}]+/gu, '')
  return left === ''
}

/** The "when" in a snooze: "in 2 hours", "for 30 min", "at 5pm", "tonight", "later". Returns a phrase snoozeUntil() reads. */
export function snoozePhrase(text) {
  const t = String(text || '').toLowerCase()
  let m
  if ((m = t.match(/\b(\d{1,3})\s*(m|min|mins|minutes?|h|hr|hrs|hours?|d|days?)\b/))) return `${m[1]}${m[2][0] === 'm' ? 'm' : m[2][0]}`
  if (/\bhalf an? hour\b/.test(t)) return '30m'
  if (/\ban? hour\b|\bone hour\b/.test(t)) return '1h'
  if (/\ban? (?:couple|few) (?:of )?hours\b/.test(t)) return '2h'
  if ((m = t.match(/\b(\d{1,2}(?::\d{2})?\s*(?:am|pm))\b/)) || (m = t.match(/\b(\d{1,2}:\d{2})\b/))) return m[1].replace(/\s+/g, '')
  if (/\b(tonight|this evening|after dinner|malam)\b/.test(t)) return 'tonight'
  if (/\b(tomorrow|tmr|tmrw|besok)\b/.test(t)) return 'tomorrow'
  return 'later'
}

// task names: short forms people use for subjects and chores
const ABBR = {
  bio: 'biology', chem: 'chemistry', phys: 'physics', physic: 'physics', math: 'mathematics', maths: 'mathematics',
  eng: 'english', lit: 'literature', hist: 'history', geo: 'geography', econ: 'economics', hw: 'homework', pr: 'homework',
  ws: 'worksheet', assgn: 'assignment', assignmt: 'assignment', pres: 'presentation', prez: 'presentation', lab: 'lab',
  ppt: 'presentation', bm: 'malay', cl: 'chinese', comp: 'computing', cs: 'computing',
}
// words that say what to do, not which task
const NOT_NAME = new Set(('i im me my mine the a an to of for on in at with it its that this those these one ones thing stuff task tasks '
  + 'done did do does doing finished finish finishing completed complete submitted submit handed hand ticked tick off got get all already just '
  + 'finally ok okay yes yeah now start started starting begin beginning working work on gonna going about will let lets go '
  + 'delete remove cancel scrap drop rid of from list dont do not need anymore never mind take '
  + 'move push postpone reschedule shift bump delay change instead put till until by later tomorrow tmr today tonight next week '
  + 'monday tuesday wednesday thursday friday saturday sunday mon tue wed thu fri sat sun weekend '
  + 'remind snooze again ask ping nudge hour hours minutes min mins please pls can cant and as mark sudah selesai udah kelar '
  + 'hapus pindah ke besok mulai kerjain number no yep yup ya yeah yea sure alright right really so too also w with oh ah hmm '
  + 'is are was were be been has have had am up out over back pretty quite very lah leh lor sia bro '
  + 'give wait busy ask not yet right bit soon then first part step steps aja nanti dulu').split(' '))

const norm = (w) => {
  w = w.toLowerCase().replace(/[^\p{L}\p{N}]/gu, '')
  return ABBR[w] || w
}
function bigrams(s) { const out = []; for (let i = 0; i < s.length - 1; i++) out.push(s.slice(i, i + 2)); return out }
function dice(a, b) {
  if (a === b) return 1
  if (a.length < 2 || b.length < 2) return 0
  const A = bigrams(a), B = bigrams(b)
  let hit = 0
  const pool = [...B]
  for (const x of A) { const i = pool.indexOf(x); if (i >= 0) { hit++; pool.splice(i, 1) } }
  return (2 * hit) / (A.length + B.length)
}
/** How well one word the person wrote matches one word of a task's title (0–1). */
function wordMatch(q, w) {
  if (q === w) return 1
  if (q.length >= 3 && w.length >= 3 && (w.startsWith(q) || q.startsWith(w))) return 0.9
  const d = dice(q, w)
  return d >= 0.7 ? d * 0.9 : 0
}
/** The words in a message that could name a task (what's left after the "doing" words). */
export function nameWords(text) {
  return String(text || '').split(/\s+/).map(norm).filter((w) => w.length >= 2 && !NOT_NAME.has(w) && !/^\d+$/.test(w) && !/^\d/.test(w))
}
/**
 * Which of these tasks the message is about, by name. Returns { task } for a clear
 * winner, { many: [tasks] } when it could be more than one, or { none: true }.
 */
export function findTask(text, tasks) {
  const q = nameWords(text)
  if (!q.length) return { empty: true }
  const scored = tasks.map((t) => {
    const tw = String(t.title || '').split(/\s+/).map(norm).filter((w) => w.length >= 2)
    if (!tw.length) return { t, s: 0 }
    let sum = 0, strong = 0
    for (const x of q) {
      const best = Math.max(0, ...tw.map((w) => wordMatch(x, w)))
      sum += best
      if (best >= 0.85) strong++
    }
    return { t, s: strong ? sum / q.length : 0 }
  }).filter((x) => x.s >= 0.45).sort((a, b) => b.s - a.s)
  if (!scored.length) return { none: true }
  if (scored.length > 1 && scored[1].s >= scored[0].s - 0.1) return { many: scored.filter((x) => x.s >= scored[0].s - 0.1).slice(0, 5).map((x) => x.t) }
  return { task: scored[0].t, score: scored[0].s }
}
