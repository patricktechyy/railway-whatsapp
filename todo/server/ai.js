import { limitsOf } from './aiusage.js'
/**
 * Buddy's optional AI, so you can talk to Buddy like a person: "when is the eartips thing?",
 * "push maths to friday and tick off bio", "thanks!". It answers in a short message and can
 * propose commands ("/move K3 fri"); anything that changes a task waits for your tap (a list
 * just runs). Uses Groq's free API (an OpenAI-style chat endpoint). It sees your message, the
 * last half hour of your chat with Buddy, your open tasks (code, title, when, notes) and what
 * you finished in the last few days. Nothing else.
 * No key, an error, a timeout or the daily limit: Buddy carries on without it.
 *
 * Groq retires models now and then (llama-3.1-8b-instant went in August 2026). When the model
 * is gone, this asks Groq which models it has, switches to a good one and tries again, so
 * Buddy keeps working without anyone changing a setting.
 */

/** Good at following a conversation and fast on Groq, best first (the 120b has the same free limits as the 20b). Anything else Groq lists is a last resort. */
export const PREFERRED_MODELS = ['openai/gpt-oss-120b', 'openai/gpt-oss-20b', 'qwen/qwen3.8-27b', 'qwen/qwen3.6-27b']
export const DEFAULT_MODEL = PREFERRED_MODELS[0]
const NOT_CHAT = /whisper|tts|orpheus|guard|safeguard|compound|embed|playai|distil/i

/** How the AI is doing: shown on the admin's AI card. */
export const aiStatus = { at: 0, ok: null, model: null, error: null, switchedFrom: null, ms: 0 }
let picked = null // the model we switched to after the configured one was gone

// Kept short on purpose: every answer sends it, and Groq's free tier counts the tokens.
// It never changes, so it comes first: Groq caches a prompt's unchanged start.
const SYSTEM = `You are Buddy, a to-do assistant people text on WhatsApp. Reply like a quick, friendly friend, in their language and tone.
Answer with JSON only: {"reply":"...","commands":[]}
reply: 1-2 short sentences, under 240 characters. Name tasks by *title*, never by code. At most one emoji.
commands (up to 5; codes from Tasks; days/times in words: "fri 3pm", "tomorrow", "6pm", "25 oct", "30m"):
/today /tomorrow /week /overdue (lists) | /task CODE (one task's card) | /study [tomorrow] | /exams [day]
/add WORDS [day] [time] | /done CODE | /start CODE | /step CODE | /snooze CODE WHEN | /move CODE WHEN | /rename CODE NAME | /delete CODE | /undo
Read-only ones run at once (a list is shown instead of your reply). Changes become a Yes/No question they tap; your reply isn't shown then. Never say a change is done.
Rules:
- Days: always look them up in Calendar ("day after tomorrow" is marked, "this fri" is the first Fri). Write days like "Tue 27 Oct".
- Follow the chat: short follow-ups ("yeah", "no?", "and the other one?") continue the last topic and task. "it"/"that": the task they're replying to, else the one just discussed. A correction ("that's tomorrow not today") means redo it for the right day.
- Match tasks loosely (typos, other words for it). If one fits, answer about it; ask "which one?" only if two or more fit.
- Questions: answer from the data, copying the times. Never invent tasks, dates or times. No exam that day: say so, and when the next one is.
- "Any tasks today/tomorrow/this week?": the list command. /task is for one task only.
- Something new to do or remember: /add. Asked about a task that isn't there: say so and offer /add.
- "no", "nevermind": drop it. "uh", "?": ask what they need. Thanks or chat: short and kind, no commands.`

class AiError extends Error {
  constructor(message, { status = 0, code = '', modelGone = false, noJsonMode = false, limits = null } = {}) {
    super(message)
    Object.assign(this, { status, code, modelGone, noJsonMode, limits })
  }
}

async function chat({ base, key, model, messages, jsonMode, signal, maxTokens = 1500 }) {
  const r = await fetch(`${base}/chat/completions`, {
    method: 'POST',
    signal,
    headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      model,
      temperature: 0,
      max_completion_tokens: maxTokens, // reasoning models think first; the answer itself is short
      ...(/gpt-oss/i.test(model) ? { reasoning_effort: 'low', include_reasoning: false } : {}),
      ...(jsonMode ? { response_format: { type: 'json_object' } } : {}),
      messages,
    }),
  })
  const limits = limitsOf(r.headers)
  if (!r.ok) {
    let err = {}
    try { err = (await r.json())?.error || {} } catch {}
    const msg = String(err.message || '')
    const code = String(err.code || err.type || '')
    // 429: Groq says which limit ("… on tokens per minute (TPM) …", "… requests per day (RPD) …")
    const wait = msg.match(/try again in ((?:\d+(?:\.\d+)?[hms])+)/i)?.[1] || (limits.retryAfter ? `${limits.retryAfter}s` : null)
    const perMinute = /per minute|\b(TPM|RPM)\b/i.test(msg) || (!/per day|\b(TPD|RPD)\b/i.test(msg) && limits.retryAfter !== null && limits.retryAfter < 120)
    const limitText = perMinute ? `per-minute limit reached${wait ? `, free again in ${wait}` : ''}` : `daily limit reached${wait ? `, free again in ${wait}` : ''}`
    throw new AiError(r.status === 429 ? limitText : `HTTP ${r.status}${code ? ` ${code}` : ''}${msg ? `: ${msg.slice(0, 160)}` : ''}`, {
      status: r.status,
      code,
      limits,
      modelGone: r.status === 404 || /model_not_found|model_decommissioned|decommissioned|does not exist|not found/i.test(`${code} ${msg}`),
      noJsonMode: r.status === 400 && /response_format|json/i.test(msg),
    })
  }
  return { data: await r.json(), limits }
}

/** The models Groq has right now, the best one for this first. */
async function findModel(base, key, signal, not) {
  const r = await fetch(`${base}/models`, { headers: { authorization: `Bearer ${key}` }, signal })
  if (!r.ok) return null
  const ids = ((await r.json())?.data || []).filter((m) => m.active !== false).map((m) => String(m.id)).filter((id) => id !== not)
  return PREFERRED_MODELS.find((m) => ids.includes(m)) || ids.find((id) => !NOT_CHAT.test(id)) || null
}

/** The answer in a reply: plain JSON, or JSON wrapped in ```json fences or other words. */
export function answerOf(content) {
  const text = String(content || '').trim()
  let out = null
  try { out = JSON.parse(text) } catch {
    const m = text.match(/\{[\s\S]*\}/)
    if (m) { try { out = JSON.parse(m[0]) } catch {} }
  }
  if (!out || typeof out !== 'object') return { reply: null, commands: [] }
  const list = Array.isArray(out.commands) ? out.commands : typeof out.command === 'string' ? [out.command] : []
  const commands = list.filter((c) => typeof c === 'string').map((c) => c.trim()).filter((c) => c.startsWith('/') && c.length <= 200 && !c.includes('\n')).slice(0, 5)
  const reply = typeof out.reply === 'string' && out.reply.trim() ? out.reply.trim().slice(0, 600) : null
  return { reply, commands }
}

/**
 * One request to Groq, with its fallbacks: a retired model is swapped for a current one, a model
 * without JSON mode is asked without it. Returns the reply's text. Throws a readable Error.
 */
async function complete({ key, model, messages, track, timeoutMs, base, maxTokens = 1500 }) {
  base = base.replace(/\/$/, '')
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), timeoutMs)
  const started = Date.now()
  let use = picked || model || DEFAULT_MODEL
  let jsonMode = true
  try {
    for (let attempt = 0; ; attempt++) {
      const t0 = Date.now()
      try {
        const { data, limits } = await chat({ base, key, model: use, messages, jsonMode, signal: ctrl.signal, maxTokens })
        Object.assign(aiStatus, { at: Date.now(), ok: true, model: use, error: null, ms: Date.now() - started })
        try { track?.({ ok: true, model: use, usage: data?.usage || null, limits, ms: Date.now() - t0 }) } catch {}
        return data?.choices?.[0]?.message?.content || ''
      } catch (e) {
        // every request counts towards Groq's limits, the failed ones too
        try { track?.({ ok: false, model: use, usage: null, limits: e?.limits || null, error: e?.name === 'AbortError' ? 'no answer in time' : e?.message, ms: Date.now() - t0 }) } catch {}
        if (attempt >= 2 || !(e instanceof AiError)) throw e
        if (e.noJsonMode && jsonMode) { jsonMode = false; continue }
        if (e.modelGone) {
          const alt = await findModel(base, key, ctrl.signal, use)
          if (!alt || alt === use) throw e
          console.warn(`[buddy] AI model ${use} is gone at Groq; using ${alt}`)
          aiStatus.switchedFrom = use
          picked = use = alt
          continue
        }
        throw e
      }
    }
  } catch (e) {
    const error = e?.name === 'AbortError' ? `no answer within ${Math.round(timeoutMs / 1000)} s` : e.message
    Object.assign(aiStatus, { at: Date.now(), ok: false, model: use, error, ms: Date.now() - started })
    throw new Error(error)
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Ask the AI what to say back and which commands to run (or propose).
 * Returns { reply, commands }. Throws (with a readable message) when Groq can't be used.
 */
export async function askBuddy({ key, model = null, text, name = '', calendar = [], tasks = [], exams = [], finished = [], now = '', current = null, history = [], track = null, timeoutMs = 12000, base = process.env.GROQ_BASE_URL || 'https://api.groq.com/openai/v1' }) {
  if (!key || !text) return { reply: null, commands: [] }
  // plain lines, not JSON (fewer tokens); what changes least goes first (Groq caches an unchanged start)
  const context = [
    `Name: ${name}`,
    `Calendar: ${calendar.join(', ')}`,
    `Tasks (code · title · when · extra):\n${tasks.slice(0, 30).join('\n') || '(none)'}`,
    exams.length ? `Exams:\n${exams.slice(0, 12).join('\n')}` : '',
    finished.length ? `Done lately:\n${finished.slice(0, 8).join('\n')}` : '',
  ].filter(Boolean).join('\n')
  const messages = [
    { role: 'system', content: SYSTEM },
    { role: 'system', content: context },
    ...history.slice(-8).filter((m) => (m.role === 'user' || m.role === 'assistant') && m.content).map((m) => ({ role: m.role, content: String(m.content).slice(0, 300) })),
    { role: 'user', content: `[${now}${current ? `; replying to ${current}` : ''}] ${String(text).slice(0, 500)}` },
  ]
  return answerOf(await complete({ key, model, messages, track, timeoutMs, base, maxTokens: 800 }))
}

// ------------------------------------------------- checking Buddy's own reading
const READ_ADD = `You check how a to-do bot read a new task. Split the message into the task and its day/time.
Reply with JSON only: {"title": "...", "date": "YYYY-MM-DD" or null, "time": "HH:MM" (24-hour) or null}
- "title": the person's own words for the task, minus the words that only say when (keep their spelling; don't add or rephrase).
- Days: look them up in "calendar" (date for each of the next 15 days); never work a date out yourself. "tonight" without a time = 20:00, "noon" = 12:00, "morning" alone = 09:00, "evening" alone = 19:00.
- "9.30PM", "930pm", "21.30", "jam 5 sore" (5 PM) are times. A number that's an amount ("2 eggs", "$12.50", "page 30") is not.
- No day or time in it: both null. Never guess one.`
const READ_WHEN = `You read when someone means, for a to-do bot. Reply with JSON only: {"date": "YYYY-MM-DD" or null, "time": "HH:MM" (24-hour) or null}
- Days: look them up in "calendar" (date for each of the next 15 days); never work a date out yourself. "tonight" without a time = 20:00, "noon" = 12:00, "morning" = 09:00, "evening" = 19:00. "in 2 hours" etc.: work it out from "now".
- Not a day or time at all: both null. Never guess.`

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/
/**
 * The AI's reading of a new task ("add") or of a day/time ("when"). Returns { title, date, time }
 * (title only for "add"); anything that isn't a proper date or time comes back as null.
 */
export async function readWhen({ key, model = null, text, mode = 'add', calendar = [], now = '', track = null, timeoutMs = 9000, base = process.env.GROQ_BASE_URL || 'https://api.groq.com/openai/v1' }) {
  const messages = [
    { role: 'system', content: mode === 'add' ? READ_ADD : READ_WHEN },
    { role: 'user', content: JSON.stringify({ message: String(text).slice(0, 300), now, calendar }) },
  ]
  const content = await complete({ key, model, messages, track, timeoutMs, base, maxTokens: 400 })
  let out = null
  try { out = JSON.parse(content) } catch { const m = String(content).match(/\{[\s\S]*\}/); if (m) { try { out = JSON.parse(m[0]) } catch {} } }
  const date = typeof out?.date === 'string' && DATE_RE.test(out.date) ? out.date : null
  const time = typeof out?.time === 'string' && TIME_RE.test(out.time.padStart(5, '0')) ? out.time.padStart(5, '0') : null
  const title = typeof out?.title === 'string' ? out.title.replace(/\s+/g, ' ').trim().slice(0, 200) : null
  return { title: title || null, date, time }
}
