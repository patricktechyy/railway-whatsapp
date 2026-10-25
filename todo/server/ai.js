/**
 * Buddy's optional AI: turns a plain sentence ("push maths to friday") into one of Buddy's
 * commands ("/move K3 fri"). It only proposes: Buddy shows it and you confirm with a tap
 * (a list just runs). Uses Groq's free API (an OpenAI-style chat endpoint). It sees that one
 * message, your open tasks' codes, titles and dates, and today's date. Nothing else.
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

const SYSTEM = `You turn a WhatsApp message into ONE command for a to-do bot. Reply with JSON only, exactly {"command": "..."} or {"command": null}.

Commands (codes look like K7; dates/times in plain words like "fri 3pm", "tomorrow", "6pm", "25 oct"):
/today | /tomorrow | /week | /overdue | /study | /exams | /help
/task <code> - show one task
/add <task words> [day] [time] - a NEW task; keep the user's words for the task, add the day/time they said
/done <code> | /start <code> | /step <code> - tick off / start / tick next step
/snooze <code> <when> - remind again later, e.g. "/snooze K7 30m", "/snooze K7 tonight"
/move <code> <day and/or time> - reschedule, e.g. "/move K7 fri 3pm"
/rename <code> <new name>
/delete <code>

Rules:
- Questions about what's on ("anything tomorrow?", "what do I have today") are the list commands.
- Use only codes from the task list given. Pick the task whose title the message clearly means. If the message says "it"/"that" and "current" is given, use that code.
- If it's unclear which task, or the message isn't about tasks (greetings, chat, other topics), reply {"command": null}.
- Never invent a code. Never combine two commands. No explanations.`

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
      max_completion_tokens: 1024, // reasoning models think first; the answer itself is tiny
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

/** The command in a reply: plain JSON, or JSON wrapped in ```json fences or other words. */
function commandOf(content) {
  const text = String(content || '').trim()
  let out = null
  try { out = JSON.parse(text) } catch {
    const m = text.match(/\{[\s\S]*\}/)
    if (m) { try { out = JSON.parse(m[0]) } catch {} }
  }
  const cmd = typeof out?.command === 'string' ? out.command.trim() : null
  return cmd && cmd.startsWith('/') && cmd.length <= 200 && !cmd.includes('\n') ? cmd : null
}

export async function proposeCommand({ key, model = null, text, tasks = [], today, now, current = null, timeoutMs = 9000, base = process.env.GROQ_BASE_URL || 'https://api.groq.com/openai/v1' }) {
  if (!key || !text) return null
  base = base.replace(/\/$/, '')
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), timeoutMs)
  const started = Date.now()
  const messages = [
    { role: 'system', content: SYSTEM },
    { role: 'user', content: JSON.stringify({ message: String(text).slice(0, 300), today, now, current, tasks: tasks.slice(0, 60) }) },
  ]
  let use = picked || model || DEFAULT_MODEL
  let jsonMode = true
  try {
    for (let attempt = 0; ; attempt++) {
      try {
        const data = await chat({ base, key, model: use, messages, jsonMode, signal: ctrl.signal })
        const cmd = commandOf(data?.choices?.[0]?.message?.content)
        Object.assign(aiStatus, { at: Date.now(), ok: true, model: use, error: null, ms: Date.now() - started })
        return cmd
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
