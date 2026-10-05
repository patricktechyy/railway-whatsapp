import { parseQuickAdd, hostOf } from './quickadd.js'
import { describeRepeat } from './repeat.js'
import { todayIn } from './tz.js'
import { HttpError } from './auth.js'

/**
 * What the Todolist does with the WhatsApp link: turn tasks into WhatsApp
 * messages, and WhatsApp "todo:" messages into tasks.
 */

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const PRIORITY = ['', 'Low', 'Medium', 'High']
const STATUS = { todo: 'Not started', doing: 'In progress', done: 'Completed' }

const keyDate = (k) => { const [y, m, d] = k.split('-').map(Number); return new Date(Date.UTC(y, m - 1, d)) }
const dayDiff = (a, b) => Math.round((keyDate(b) - keyDate(a)) / 864e5)
export const time12 = (t) => { const [h, m] = t.split(':').map(Number); return `${h % 12 || 12}:${String(m).padStart(2, '0')} ${h < 12 ? 'AM' : 'PM'}` }

/** "Today", "Tomorrow", or "Mon 5 Oct" relative to the person's own today. */
export function dayLabel(k, today) {
  const diff = dayDiff(today, k)
  if (diff === 0) return 'Today'
  if (diff === 1) return 'Tomorrow'
  if (diff === -1) return 'Yesterday'
  const d = keyDate(k)
  return `${DAYS[d.getUTCDay()]} ${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}`
}

export const dueText = (t, today) => (t.due ? `${dayLabel(t.due, today)}${t.time ? `, ${time12(t.time)}` : ''}` : '')

/** A task written out as a WhatsApp message (WhatsApp understands *bold* and _italic_). */
export function taskMessage(t, { today, listName, brand }) {
  const lines = [`📝 *${t.title}*`]
  const meta = [
    t.due && `📅 ${dueText(t, today)}`,
    t.repeat && `🔁 ${describeRepeat(t.repeat)}`,
    t.priority > 0 && `🚩 ${PRIORITY[t.priority]}`,
    listName && `📂 ${listName}`,
  ].filter(Boolean)
  if (meta.length) lines.push(meta.join(' · '))
  if (t.status && t.status !== 'todo') lines.push(`Status: ${STATUS[t.status]}`)
  if (t.subtasks?.length) lines.push('', ...t.subtasks.map((s) => `${s.done ? '☑' : '☐'} ${s.title}`))
  if (t.notes?.trim()) lines.push('', t.notes.trim())
  if (t.links?.length) lines.push('', ...t.links.map((l) => `🔗 ${l.title ? `${l.title}: ` : ''}${l.url}`))
  if (t.tags?.length) lines.push('', t.tags.map((x) => `#${x}`).join(' '))
  lines.push('', `_from ${brand}_`)
  return lines.join('\n')
}

export function reminderMessage(t, today) {
  const bits = [t.due && `Due ${dueText(t, today)}`, t.notes?.split('\n')[0]].filter(Boolean)
  return `🔔 *${t.title}*${bits.length ? `\n${bits.join(' · ')}` : ''}`
}

const INBOX_RE = /^\s*(todo|to-do|td)\s*(\?|:|\s)\s*/i

/** The message without its "todo:" / "td " start ("todo" or "td" alone → ""). */
export const stripTodo = (text) => (/^\s*(todo|to-do|td)\s*$/i.test(text || '') ? '' : String(text || '').replace(INBOX_RE, '').trim())

/** Is this WhatsApp text meant for the Todolist? (The WhatsApp app checks the same.) */
export const isTodoCommand = (text) => INBOX_RE.test(text) || /^\s*todo\s*\??\s*$/i.test(text)

/**
 * Handle a message sent from WhatsApp's "Message yourself" chat.
 *   todo: buy milk tomorrow 5pm !2 #shop   → adds a task
 *   todo?  /  todo today                   → lists today's open tasks
 * Returns the reply to send back to the same chat.
 */
export function handleInbox(store, username, text, { tz }) {
  const today = todayIn(tz)
  const raw = String(text || '').trim()
  const body = raw.replace(INBOX_RE, '').trim()
  const doc = store.snapshot(username)

  if (!body || /^(\?|today|list)$/i.test(body) || /^todo\s*\?$/i.test(raw)) {
    const open = doc.tasks.filter((t) => !t.done && t.due && t.due <= today)
      .sort((a, b) => a.due.localeCompare(b.due) || (a.time || '99').localeCompare(b.time || '99'))
    if (!open.length) return { reply: '📋 Nothing due today.' }
    const rows = open.slice(0, 20).map((t) => `${t.status === 'doing' ? '◐' : '○'} ${t.title}${t.time ? ` · ${time12(t.time)}` : ''}${t.due < today ? ' _(overdue)_' : ''}`)
    return { reply: `📋 *Today* (${open.length})\n${rows.join('\n')}${open.length > 20 ? `\n…and ${open.length - 20} more` : ''}` }
  }

  const parsed = parseQuickAdd(body, doc.lists, today)
  if (!parsed.title) throw new HttpError(400, 'Nothing to add')
  const { hints: _h, ...fields } = parsed
  if (fields.time && fields.remind === undefined) fields.remind = 0
  const task = store.addTask(username, fields)
  const list = task.listId && doc.lists.find((l) => l.id === task.listId)
  const extra = [
    task.due && dueText(task, today),
    task.repeat && `🔁 ${describeRepeat(task.repeat)}`,
    task.priority > 0 && `🚩 ${PRIORITY[task.priority]}`,
    list && `${list.emoji} ${list.name}`,
    task.links?.length && `🔗 ${task.links.map((l) => hostOf(l.url)).join(', ')}`,
  ].filter(Boolean)
  return { reply: `✅ Added: *${task.title}*${extra.length ? `\n${extra.join(' · ')}` : ''}`, task }
}
