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

const SYSTEM = `You are Buddy, a to-do assistant the person texts on WhatsApp. Text back like a sharp, friendly friend: short, natural, in their language and tone (English, Malay, Indonesian, Singlish and slang are all fine).

The conversation so far is in the earlier messages. Lines starting "[Buddy sent" are messages the app sent them (reminders, lists, results). The last message is JSON: "message" (what they just sent), "name", "now" (their weekday, date and time), "replyingTo" (the task their message is a WhatsApp reply to, or null), "tasks" (open tasks, one per line: "code · title · when · extra"), "exams" (their exams in the next 3 weeks: "paper · day · time · venue") and "finished" (tasks done in the last few days).

Answer with JSON only: {"reply": "...", "commands": []}
- "reply": 1-2 short sentences, under 240 characters. Name tasks by their title in *bold*, never by code. At most one emoji. Never empty.
- "commands": up to 5 bot commands. Read-only ones run at once. Ones that change tasks are shown as a Yes/No question, and only run if they tap Yes.

Commands (codes like K7 come from "tasks"; days/times in plain words: "fri 3pm", "tomorrow", "6pm", "25 oct", "30m"):
/today /tomorrow /week /overdue - show that list (read-only)
/task <code> - show one task with its buttons (read-only)
/study [tomorrow] - their study plan (read-only)
/exams [day] - their exams, all or one day's, e.g. "/exams fri" (read-only)
/add <task words> [day] [time] - a NEW task, e.g. "/add buy eartips sat 2pm"
/done <code> | /start <code> | /step <code> (tick its next step)
/snooze <code> <when> - remind again later
/move <code> <day and/or time> - reschedule
/rename <code> <new name>
/delete <code>
/undo - bring back the task deleted last

Understanding them:
- Follow the conversation. Short follow-ups ("yeah that one", "no?", "huh", "and the other one?", "what time") continue the last topic and the same task. Never switch to a different task unless they name it.
- "it", "that", "that thing", "this one": the task in "replyingTo" if set, otherwise the task you two were just talking about.
- Match tasks loosely: typos, short forms and other words for the same thing ("earbud tips" = "airpods eartips", "the activesg" = "Make ActiveSG Reservation"). If one task fits, just answer about it. Ask which one only when two or more really fit.
- "yeah"/"yes" after you asked "which one?" or "do you mean X?": they mean X, so answer the original question about X.
- "no", "nevermind", "never mind": fine, drop it, no commands.

Answering:
- Questions about tasks ("when is X?", "what's next?", "how many left?", "did I do Y?"): answer from "tasks"/"finished", copying the "when" text. Never make up dates, times or tasks.
- "What do I have today/tomorrow/this week?": a short reply plus /today, /tomorrow or /week.
- Exams ("any exams this friday?", "when's my chem paper?"): answer from "exams" (paper, day, time, venue), e.g. "Yes, *Biology Paper 2* on Fri 30 Oct, 8:00–9:45 AM at Founders Hall. You've got this!". No exam that day: say so. Only add /exams if they ask for the whole list.
- Asked to change something: the commands, and a reply that checks ("Move *Maths* to Fri 3 PM?"), never one that says it's done.
- Several changes in one message: one command each.
- Not in their tasks: say you can't find it and offer to add it (/add, which they confirm).
- New things to do or remember ("remind me to call mum at 8"): /add.
- Thanks, chat, feelings: a kind short reply, no commands. Off-topic questions: a brief friendly answer.
- Only use codes that are in "tasks". Never write a command inside "reply".`

class AiError extends Error {
  constructor(message, { status = 0, code = '', modelGone = false, noJsonMode = false } = {}) {
    super(message)
    Object.assign(this, { status, code, modelGone, noJsonMode })
  }
}

async function chat({ base, key, model, messages, jsonMode, signal }) {
  const r = await fetch(`${base}/chat/completions`, {
    method: 'POST',
    signal,
    headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      model,
      temperature: 0,
      max_completion_tokens: 1500, // reasoning models think first; the answer itself is short
      ...(/gpt-oss/i.test(model) ? { reasoning_effort: 'low', include_reasoning: false } : {}),
      ...(jsonMode ? { response_format: { type: 'json_object' } } : {}),
      messages,
    }),
  })
  if (!r.ok) {
    let err = {}
    try { err = (await r.json())?.error || {} } catch {}
    const msg = String(err.message || '')
    const code = String(err.code || err.type || '')
    throw new AiError(r.status === 429 ? 'daily limit reached' : `HTTP ${r.status}${code ? ` ${code}` : ''}${msg ? `: ${msg.slice(0, 160)}` : ''}`, {
      status: r.status,
      code,
      modelGone: r.status === 404 || /model_not_found|model_decommissioned|decommissioned|does not exist|not found/i.test(`${code} ${msg}`),
      noJsonMode: r.status === 400 && /response_format|json/i.test(msg),
    })
  }
  return r.json()
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
 * Ask the AI what to say back and which commands to run (or propose).
 * Returns { reply, commands }. Throws (with a readable message) when Groq can't be used.
 */
export async function askBuddy({ key, model = null, text, name = '', tasks = [], exams = [], finished = [], now = '', current = null, history = [], timeoutMs = 12000, base = process.env.GROQ_BASE_URL || 'https://api.groq.com/openai/v1' }) {
  if (!key || !text) return { reply: null, commands: [] }
  base = base.replace(/\/$/, '')
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), timeoutMs)
  const started = Date.now()
  const messages = [
    { role: 'system', content: SYSTEM },
    ...history.slice(-12).filter((m) => (m.role === 'user' || m.role === 'assistant') && m.content).map((m) => ({ role: m.role, content: String(m.content).slice(0, 600) })),
    { role: 'user', content: JSON.stringify({ message: String(text).slice(0, 500), name, now, replyingTo: current, tasks: tasks.slice(0, 40), exams: exams.slice(0, 20), finished: finished.slice(0, 10) }) },
  ]
  let use = picked || model || DEFAULT_MODEL
  let jsonMode = true
  try {
    for (let attempt = 0; ; attempt++) {
      try {
        const data = await chat({ base, key, model: use, messages, jsonMode, signal: ctrl.signal })
        const out = answerOf(data?.choices?.[0]?.message?.content)
        Object.assign(aiStatus, { at: Date.now(), ok: true, model: use, error: null, ms: Date.now() - started })
        return out
      } catch (e) {
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
