/**
 * Buddy's optional AI, so you can talk to Buddy like a person: "when is the eartips thing?",
 * "push maths to friday and tick off bio", "thanks!". It answers in a short message and can
 * propose commands ("/move K3 fri"); anything that changes a task waits for your tap (a list
 * just runs). Uses Groq's free API (an OpenAI-style chat endpoint). It sees your message, the
 * last few messages of your chat with Buddy, your open tasks (code, title, when, notes) and what
 * you finished in the last few days. Nothing else.
 * No key, an error, a timeout or the daily limit: Buddy carries on without it.
 *
 * Groq retires models now and then (llama-3.1-8b-instant went in August 2026). When the model
 * is gone, this asks Groq which models it has, switches to a good one and tries again, so
 * Buddy keeps working without anyone changing a setting.
 */

/** Small, fast models that follow instructions well, best first. Anything else Groq lists is a last resort. */
export const PREFERRED_MODELS = ['openai/gpt-oss-20b', 'openai/gpt-oss-120b', 'qwen/qwen3.8-27b', 'qwen/qwen3.6-27b']
export const DEFAULT_MODEL = PREFERRED_MODELS[0]
const NOT_CHAT = /whisper|tts|orpheus|guard|safeguard|compound|embed|playai|distil/i

/** How the AI is doing: shown on the admin's AI card. */
export const aiStatus = { at: 0, ok: null, model: null, error: null, switchedFrom: null, ms: 0 }
let picked = null // the model we switched to after the configured one was gone

const SYSTEM = `You are Buddy, a friendly to-do assistant inside WhatsApp. Talk like a helpful friend texting back: short, warm, natural, in the same language and tone the person uses (English, Malay, Indonesian, Singlish, slang are all fine).

You get JSON with: "message" (what they just sent), "name", "now" (their local date, weekday and time), "current" (the task code you were just talking about, if any), "recent" (the last few messages of this chat), "tasks" (their open tasks, one per line: "code · title · when · flags/notes") and "finished" ("title · when it was done", the last few days).

Reply with JSON only: {"reply": "...", "commands": ["..."]}
- "reply": what you say back, 1-2 short sentences (max ~240 characters). WhatsApp *bold* is fine, at most one emoji. Never empty.
- "commands": [] or up to 5 bot commands to run. Read-only ones run straight away; ones that change tasks are shown to the person to confirm with a tap first.

Commands (task codes look like K7; days/times in plain words like "fri 3pm", "tomorrow", "6pm", "25 oct", "30m"):
/today /tomorrow /week /overdue - show that list (read-only)
/task <code> - show one task with its buttons (read-only)
/study /exams /help - read-only
/add <task words> [day] [time] - a NEW task, e.g. "/add buy eartips sat 2pm"
/done <code> | /start <code> | /step <code> (tick the next step)
/snooze <code> <when> - remind again later
/move <code> <day and/or time> - reschedule
/rename <code> <new name>
/delete <code>
/undo - bring back the task deleted last

How to answer:
- Questions you can answer from the data ("when is X?", "what's next?", "how many left today?", "did I finish Y?"): answer in "reply" using the "when" text exactly as given. Never make up dates, times or tasks. Add /task <code> only if they want to see or change that one task.
- "What do I have today/tomorrow/this week?": a short reply plus the list command (/today, /tomorrow, /week, /overdue).
- Asked to change something: put the commands in "commands" and phrase "reply" as checking with them ("Move *Maths* to Fri 3 PM?"), never as already done, because nothing happens until they tap Yes.
- Several things at once ("move maths to fri and tick off bio"): one command each.
- "it"/"that"/"this one" means "current", or the task "recent" was about.
- Can't tell which task they mean: ask in "reply" which one (name the likely ones), no commands.
- A task they ask about that isn't in the list: say you can't find it, and offer to add it with /add.
- Something to remember or do that's new ("remind me to call mum at 8"): /add it.
- Small talk, thanks, feelings: just a kind short reply, no commands. Off-topic questions: a brief friendly answer is fine, then you can steer back to their tasks.
- Use only codes that appear in "tasks". Never invent a code. Never put a command inside "reply".`

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
export async function askBuddy({ key, model = null, text, name = '', tasks = [], finished = [], now = '', current = null, recent = [], timeoutMs = 9000, base = process.env.GROQ_BASE_URL || 'https://api.groq.com/openai/v1' }) {
  if (!key || !text) return { reply: null, commands: [] }
  base = base.replace(/\/$/, '')
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), timeoutMs)
  const started = Date.now()
  const messages = [
    { role: 'system', content: SYSTEM },
    { role: 'user', content: JSON.stringify({ message: String(text).slice(0, 500), name, now, current, recent: recent.slice(-8), tasks: tasks.slice(0, 40), finished: finished.slice(0, 10) }) },
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
