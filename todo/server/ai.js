/**
 * Buddy's optional AI: turns a plain sentence ("push maths to friday") into one of Buddy's
 * commands ("/move K3 fri"). It only proposes: Buddy shows it and you confirm with a tap
 * (a list just runs). Uses Groq's free API (an OpenAI-style chat endpoint) with a small,
 * fast model. It sees that one message, your open tasks' codes, titles and dates, and today's
 * date. Nothing else. No key, an error, a timeout or the daily limit: Buddy carries on without it.
 */

const SYSTEM = `You turn a WhatsApp message into ONE command for a to-do bot. Reply with JSON only: {"command": "..."} or {"command": null}.

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
- Use only codes from the task list given. Pick the task whose title the message clearly means. If the message says "it"/"that" and "current" is given, use that code.
- If it's unclear which task, or the message isn't about tasks (greetings, chat, questions about other things), reply {"command": null}.
- Never invent a code. Never combine two commands. No explanations.`

export async function proposeCommand({ key, model = 'llama-3.1-8b-instant', text, tasks = [], today, now, current = null, timeoutMs = 8000, base = process.env.GROQ_BASE_URL || 'https://api.groq.com/openai/v1' }) {
  if (!key || !text) return null
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), timeoutMs)
  try {
    const r = await fetch(`${base.replace(/\/$/, '')}/chat/completions`, {
      method: 'POST',
      signal: ctrl.signal,
      headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        model,
        temperature: 0,
        max_tokens: 80,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: SYSTEM },
          { role: 'user', content: JSON.stringify({ message: String(text).slice(0, 300), today, now, current, tasks: tasks.slice(0, 60) }) },
        ],
      }),
    })
    if (!r.ok) throw new Error(r.status === 429 ? 'daily limit reached' : `HTTP ${r.status}`)
    const data = await r.json()
    const out = JSON.parse(data?.choices?.[0]?.message?.content || '{}')
    const cmd = typeof out.command === 'string' ? out.command.trim() : null
    return cmd && cmd.startsWith('/') && cmd.length <= 200 && !cmd.includes('\n') ? cmd : null
  } finally {
    clearTimeout(timer)
  }
}
