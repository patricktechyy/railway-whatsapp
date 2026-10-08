import { isHex } from '../listColor'
import { REMIND_OPTIONS, describeRemind } from '../dates'
import { useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react'
import { LIST_COLORS, type Appearance, type BuddySettings, type BuddyStyle, type List, type ListColor, type Me } from '../types'
import { AppearanceSettings, HexInput } from './AppearanceSettings'
import type { Prefs, Theme } from '../prefs'
import { deviceTip, disablePush, enablePush, permission, pushEnabledHere, pushSupport, supportMessage, testPush } from '../push'
import { chime } from '../sound'
import { toast } from './Toast'
import { api } from '../api'
import { Select } from './Select'

/**
 * A modal window. Only the person closes it (Esc, backdrop, a button): we never
 * call close() ourselves, because React's StrictMode (npm run dev) runs effects
 * twice and a close() there fired `onClose` and shut the dialog as it opened.
 */
export function Dialog({ title, onClose, children, className = '', closeButton = false }: { title: string; onClose: () => void; children: ReactNode; className?: string; closeButton?: boolean }) {
  const ref = useRef<HTMLDialogElement>(null)
  useEffect(() => {
    const d = ref.current
    if (d && !d.open) d.showModal()
  }, [])
  return (
    <dialog
      ref={ref}
      className={`dialog ${className}`}
      onCancel={(e) => { e.preventDefault(); onClose() }}
      onClick={(e) => { if (e.target === ref.current) onClose() }}
      aria-label={title}
    >
      <div className="dialog-inner">
        <div className="dialog-head">
          <h2>{title}</h2>
          {closeButton && (
            <button type="button" className="icon-btn" onClick={onClose} aria-label="Close" title="Close (Esc)">
              <svg viewBox="0 0 20 20" aria-hidden="true"><path d="M5 5l10 10M15 5 5 15" /></svg>
            </button>
          )}
        </div>
        {children}
      </div>
    </dialog>
  )
}

const EMOJIS = ['📝', '🌱', '📚', '🏠', '💼', '🛒', '💪', '🎨', '🎵', '✈️', '💡', '❤️', '🎮', '🍳', '💰', '⭐']

export function ListDialog({ list, onSave, onDelete, onClose }: {
  list?: List
  onSave: (v: { name: string; emoji: string; color: ListColor | string }) => void
  onDelete?: () => void
  onClose: () => void
}) {
  const [name, setName] = useState(list?.name || '')
  const [emoji, setEmoji] = useState(list?.emoji || '📝')
  const [color, setColor] = useState<ListColor | string>(list?.color || 'blue')
  const submit = (e: FormEvent) => {
    e.preventDefault()
    if (!name.trim()) return
    onSave({ name: name.trim(), emoji, color })
    onClose()
  }
  return (
    <Dialog title={list ? 'Edit list' : 'New list'} onClose={onClose}>
      <form onSubmit={submit}>
        <label className="field">
          <span>Name</span>
          <input value={name} onChange={(e) => setName(e.target.value)} maxLength={40} autoFocus required placeholder="e.g. Birthday party" />
        </label>
        <div className="field">
          <span className="label">Icon</span>
          <div className="emoji-grid" role="radiogroup" aria-label="Icon">
            {EMOJIS.map((x) => (
              <button type="button" key={x} role="radio" aria-checked={emoji === x} className={emoji === x ? 'on' : ''} onClick={() => setEmoji(x)}>{x}</button>
            ))}
          </div>
        </div>
        <div className="field">
          <span className="label">Colour</span>
          <div className="color-grid" role="radiogroup" aria-label="Colour">
            {LIST_COLORS.map((c) => (
              <button type="button" key={c} role="radio" aria-checked={color === c} aria-label={c} className={`c-${c}${color === c ? ' on' : ''}`} onClick={() => setColor(c)} />
            ))}
            {/* any colour you like */}
            <label className={`custom-color${isHex(color) ? ' on' : ''}`} style={isHex(color) ? { background: color } : undefined} title="Pick your own colour">
              <input type="color" value={isHex(color) ? color : '#ff5500'} onChange={(e) => setColor(e.target.value.toLowerCase())} aria-label="Custom list colour" />
              {!isHex(color) && <span aria-hidden="true">+</span>}
            </label>
          </div>
          <span className="row custom-color-row">
            <HexInput value={isHex(color) ? color : null} placeholder="#ff5500" label="List" onChange={(v) => setColor(v || 'blue')} />
          </span>
        </div>
        <div className="dialog-actions">
          {onDelete && <button type="button" className="btn danger" onClick={() => { onClose(); onDelete() }}>Delete list…</button>}
          <span className="spacer" />
          <button type="button" className="btn ghost" onClick={onClose}>Cancel</button>
          <button className="btn" disabled={!name.trim()}>{list ? 'Save' : 'Create list'}</button>
        </div>
      </form>
    </Dialog>
  )
}

export function SettingsDialog({ me, prefs, setPrefs, onRename, onWaReminders, onHolidayCountry, onAppearance, onTour, onClose, onBuddy }: {
  me: Me
  prefs: Prefs
  setPrefs: (p: Partial<Prefs>) => void
  onRename: (name: string) => void
  onWaReminders: (on: boolean) => void
  onHolidayCountry: (c: string) => void
  onAppearance: (a: Appearance) => void
  onTour: () => void
  onClose: () => void
  onBuddy: (b: BuddySettings) => void
}) {
  const [name, setName] = useState(me.name)
  // in the order you'd set things up: you → how it looks → your tasks → the calendar → being reminded → help
  return (
    <Dialog title="Settings" onClose={onClose} className="settings" closeButton>
      <section className="set-section" aria-label="You">
        <form onSubmit={(e) => { e.preventDefault(); if (name.trim() && name.trim() !== me.name) onRename(name.trim()) }}>
          <label className="field">
            <span>Your name</span>
            <span className="row">
              <input className="input" value={name} onChange={(e) => setName(e.target.value)} maxLength={60} />
              <button className="btn ghost" disabled={!name.trim() || name.trim() === me.name}>Save</button>
            </span>
            <span className="help">Signed in as <b>{me.username}</b>. Only you can see your tasks.</span>
          </label>
        </form>
      </section>

      <section className="set-section">
        <h3 className="set-title">Look</h3>
        <div className="field">
          <span className="label">Theme</span>
          <div className="seg" role="radiogroup" aria-label="Theme">
            {(['auto', 'light', 'dark'] as Theme[]).map((t) => (
              <button key={t} role="radio" aria-checked={prefs.theme === t} className={prefs.theme === t ? 'on' : ''} onClick={() => setPrefs({ theme: t })}>
                {t === 'auto' ? 'Match device' : t === 'light' ? 'Light' : 'Dark'}
              </button>
            ))}
          </div>
        </div>
        <AppearanceSettings value={me.appearance} onChange={onAppearance} />
      </section>

      <section className="set-section">
        <h3 className="set-title">Tasks</h3>
        <div className="field">
          <span className="label">Display</span>
          <label className="toggle tight">
            <input type="checkbox" checked={prefs.showProgress} onChange={(e) => setPrefs({ showProgress: e.target.checked })} />
            <span>Progress bars</span>
          </label>
          <label className="toggle tight">
            <input type="checkbox" checked={prefs.showStatus} onChange={(e) => setPrefs({ showStatus: e.target.checked })} />
            <span>Status labels</span>
          </label>
          <label className="toggle tight">
            <input type="checkbox" checked={prefs.celebrate} onChange={(e) => setPrefs({ celebrate: e.target.checked })} />
            <span>Confetti when I finish a task</span>
          </label>
        </div>
        <div className="field">
          <span className="label">Default early reminder</span>
          <Select className="input" value={prefs.defaultRemind === null ? 'none' : String(prefs.defaultRemind)} onChange={(e) => setPrefs({ defaultRemind: e.target.value === 'none' ? null : Number(e.target.value) })} aria-label="Default early reminder">
            {REMIND_OPTIONS.map((o) => <option key={String(o.value)} value={o.value === null ? 'none' : String(o.value)}>{o.value === null ? 'No reminder' : o.label}</option>)}
            {prefs.defaultRemind !== null && !REMIND_OPTIONS.some((o) => o.value === prefs.defaultRemind) && <option value={String(prefs.defaultRemind)}>{describeRemind(prefs.defaultRemind)}</option>}
          </Select>
          <span className="help">Used when you first give a task a time.</span>
        </div>
      </section>

      <section className="set-section">
        <h3 className="set-title">Calendar</h3>
        <div className="field">
          <span className="label">Public holidays</span>
          <Select className="input" value={me.holidayCountry} onChange={(e) => onHolidayCountry(e.target.value)} aria-label="Public holidays country">
            <option value="off">Don’t show holidays</option>
            {me.holidayCountries.map((c) => <option key={c.code} value={c.code}>{c.name}</option>)}
          </Select>
        </div>
        <div className="field">
          <span className="label">Week starts on</span>
          <div className="seg" role="radiogroup" aria-label="Week start">
            <button role="radio" aria-checked={prefs.weekStartsMonday} className={prefs.weekStartsMonday ? 'on' : ''} onClick={() => setPrefs({ weekStartsMonday: true })}>Monday</button>
            <button role="radio" aria-checked={!prefs.weekStartsMonday} className={!prefs.weekStartsMonday ? 'on' : ''} onClick={() => setPrefs({ weekStartsMonday: false })}>Sunday</button>
          </div>
        </div>
        <CalendarFeedSetting />
      </section>

      <section className="set-section">
        <h3 className="set-title">Notifications</h3>
        <NotificationsSetting />
        <div className="field">
          <span className="label">Sound</span>
          <span className="row wrap">
            <label className="toggle tight">
              <input type="checkbox" checked={prefs.sound} onChange={(e) => setPrefs({ sound: e.target.checked })} />
              <span>Play a sound <small>(while the app is open)</small></span>
            </label>
            <button type="button" className="btn ghost sm" disabled={!prefs.sound} onClick={() => { try { localStorage.removeItem('todo-chime-at') } catch {}; chime().unlock(); chime().play() }}>▶ Hear it</button>
          </span>
        </div>
        {me.whatsapp.configured && me.whatsapp.reminders && <WhatsAppSetting me={me} on={me.waReminders} onChange={onWaReminders} />}
      </section>

      {me.whatsapp.configured && (
        <section className="set-section">
          <h3 className="set-title">WhatsApp Buddy 🤖</h3>
          <BuddySetting me={me} onChange={onBuddy} />
        </section>
      )}

      <section className="set-section">
        <h3 className="set-title">Help</h3>
        <div className="field">
          <span className="label">Tutorial</span>
          <span className="row wrap">
            <button type="button" className="btn ghost sm" onClick={onTour}>Start the tutorial</button>
          </span>
        </div>
        <p className="help about">Version {me.version} · Name, look and holidays sync with your account. Everything else is saved on this device.</p>
      </section>

      <div className="dialog-actions pinned">
        <span className="spacer" />
        <button className="btn" onClick={onClose}>Done</button>
      </div>
    </Dialog>
  )
}

/** Turn reminders-as-notifications on/off for this device, and send a test one. */
export function NotificationsSetting() {
  const support = pushSupport()
  const [on, setOn] = useState<boolean | null>(null)
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState('')
  const blocked = support === 'ok' && permission() === 'denied'
  const [tip, setTip] = useState('')
  useEffect(() => { pushEnabledHere().then(setOn) }, [])

  const run = async (fn: () => Promise<unknown>, after?: () => void) => {
    setBusy(true)
    setMsg('')
    try { await fn(); after?.() } catch (e: any) { setMsg(e.message || 'Something went wrong') }
    setBusy(false)
  }

  return (
    <div className="field notif">
      <span className="label">Notifications on this device</span>
      {support !== 'ok' ? (
        <p className="help">{supportMessage(support)}</p>
      ) : blocked ? (
        <p className="help">Notifications are blocked for this site. Allow them in your browser’s site settings (the 🔒 by the address), then come back. {deviceTip().replace(/^Nothing showed\? /, '')}</p>
      ) : on ? (
        <>
          <span className="badge ok"><i className="dot" />On for this device</span>
          <div className="row wrap notif-actions">
            <button className="btn ghost sm" disabled={busy} onClick={() => run(testPush, () => { toast('Test sent'); setTip(deviceTip()) })}>Send a test</button>
            <button className="btn quiet sm" disabled={busy} onClick={() => run(disablePush, () => setOn(false))}>Turn off</button>
          </div>
        </>
      ) : (
        <>
          <p className="help">Get reminders as pop-ups, even when the site is closed.</p>
          <button className="btn" disabled={busy || on === null} onClick={() => run(enablePush, () => { setOn(true); toast('Notifications on') })}>
            {busy ? 'Turning on…' : 'Turn on notifications'}
          </button>
        </>
      )}
      {msg && <p className="error" role="alert">{msg}</p>}
      {tip && !msg && <p className="help notif-tip">{tip}</p>}
    </div>
  )
}

/** Where Buddy's messages land, in a few words. */
const waWhere = (me: Me) => me.whatsapp.botNumber && me.whatsapp.bot
  ? `from Buddy (${me.whatsapp.bot.phone || 'its own number'}) to your WhatsApp${me.whatsapp.phone ? ` ${me.whatsapp.phone}` : ''}`
  : 'your “Message yourself” chat'

/** Not linked yet / the bot's phone is offline: said once, where it matters. */
function WaWarning({ me }: { me: Me }) {
  if (!me.whatsapp.linked) return <p className="help warn-text">Link your WhatsApp first: open Whats Up and scan the QR code.</p>
  if (me.whatsapp.botNumber && me.whatsapp.bot && !me.whatsapp.bot.connected) return <p className="help warn-text">Buddy’s number is offline, so messages go to “Message yourself” for now.</p>
  return null
}

/** WhatsApp's *bold* and _italic_, for previews of what Buddy sends. */
function waText(s: string) {
  return s.split(/(\*[^*\n]+\*|_[^_\n]+_)/g).map((part, i) =>
    /^\*.+\*$/.test(part) ? <b key={i}>{part.slice(1, -1)}</b> : /^_.+_$/.test(part) ? <i key={i}>{part.slice(1, -1)}</i> : part)
}

/** Reminders on WhatsApp: from the Buddy bot when the admin set one up, else your "Message yourself" chat. */
function WhatsAppSetting({ me, on, onChange }: { me: Me; on: boolean; onChange: (on: boolean) => void }) {
  const [busy, setBusy] = useState(false)
  return (
    <div className="field">
      <span className="label">WhatsApp</span>
      <label className="toggle tight">
        <input type="checkbox" checked={on} onChange={(e) => onChange(e.target.checked)} />
        <span>Also send reminders to WhatsApp <small>({waWhere(me)})</small></span>
      </label>
      <WaWarning me={me} />
      {on && (
        <button className="btn ghost sm" disabled={busy} onClick={async () => {
          setBusy(true)
          try { await api('/wa/test-reminder', 'POST', {}); toast('Sent, check WhatsApp') } catch (e: any) { toast(e.message) }
          setBusy(false)
        }}>Send a test</button>
      )}
    </div>
  )
}

const STYLES: { key: BuddyStyle; label: string; sample: string }[] = [
  { key: 'friendly', label: 'Long', sample: 'Hi Gavin, reminder…\n\n📝 *Physics lab report*\n📅 Today, 4:00 PM (in 2 h)\n☑ 1/3 steps · next: _graphs_' },
  { key: 'short', label: 'Short', sample: '⏰ *Physics lab report* · Today, 4:00 PM (in 2 h)' },
]
/** "td done" → "done" for the bot's chat, where you just reply (same rules as the server's plain()). */
const plainCmd = (c: string) => c.replace(/^td\?$/, 'today').replace(/^td:\s?/, 'add ').replace(/^td /, '')
const COMMANDS: [string, string][] = [
  ['td?', 'today and overdue, numbered'],
  ['td tomorrow', 'tomorrow’s tasks'],
  ['td upcoming', 'next 7 days'],
  ['td overdue', 'overdue only'],
  ['td add buy milk tomorrow 5pm', 'add a task'],
  ['td done 2', 'complete #2 (start 2 marks it in progress)'],
  ['td step 2', 'tick the next step of #2'],
  ['td snooze 2 1h', 'remind about #2 in an hour'],
  ['td move', 'push today’s unfinished tasks to tomorrow'],
  ['td delete 2', 'delete #2 (clear completed removes all done tasks)'],
  ['td remind me to call mum at 8pm', 'add a task with a WhatsApp reminder'],
  ['td clear reminders', 'cancel WhatsApp reminders and clear Buddy’s recent reminder messages'],
  ['td clear buddy', 'clear Buddy’s recent messages'],
  ['td study', 'today’s study plan (study tomorrow for tomorrow’s)'],
  ['td tick 2', 'tick topic #2 off (again to untick)'],
  ['td exams', 'your next exams'],
  ['td help', 'full command list'],
]

/** WhatsApp Buddy: its personality, the daily messages, an example on demand, and what you can answer. */
/**
 * Asked once, when the admin has set up a bot number: where Buddy should message you.
 * "Message yourself" is the default (and private); the bot's number buzzes like a normal
 * chat, but whoever runs that number can read it.
 */
export function BuddyFromDialog({ me, onDone }: { me: Me; onDone: (via: 'self' | 'bot') => void }) {
  const [via, setVia] = useState<'self' | 'bot'>('self')
  const bot = me.whatsapp.bot!
  return (
    <Dialog title="Where should Buddy message you?" onClose={() => onDone('self')} className="buddy-from-dialog" closeButton>
      <p className="help">Buddy sends your WhatsApp reminders, and exam and study nudges. Pick where they arrive.</p>
      <div className="bf-options" role="radiogroup" aria-label="Where Buddy messages you">
        <button type="button" role="radio" aria-checked={via === 'self'} className={`bf-option${via === 'self' ? ' on' : ''}`} onClick={() => setVia('self')}>
          <span className="bf-radio" aria-hidden="true" />
          <span className="bf-body">
            <b>Message yourself <span className="bf-tag">Recommended</span></b>
            <span>🔒 Private: Buddy writes in your own “Message yourself” chat, and only you can see it. Your phone doesn’t buzz for it. Reply with <code>td done</code>, <code>td snooze 1h</code>.</span>
          </span>
        </button>
        <button type="button" role="radio" aria-checked={via === 'bot'} className={`bf-option${via === 'bot' ? ' on' : ''}`} onClick={() => setVia('bot')}>
          <span className="bf-radio" aria-hidden="true" />
          <span className="bf-body">
            <b>Buddy’s number{bot.phone ? ` (${bot.phone})` : ''}</b>
            <span>🔔 Buddy messages you like a normal contact, so your phone buzzes. 🔓 <b>Not private:</b> pake nomor Hanzel yang lama...</span>
          </span>
        </button>
      </div>
      <p className="help bf-later">You can change this any time in Settings → WhatsApp Buddy.</p>
      <div className="dialog-actions">
        <span className="spacer" />
        <button className="btn" onClick={() => onDone(via)}>Save</button>
      </div>
    </Dialog>
  )
}

function BuddySetting({ me, onChange }: { me: Me; onChange: (b: BuddySettings) => void }) {
  const [b, setB] = useState<BuddySettings>(me.buddy)
  const [kind, setKind] = useState('task')
  const [busy, setBusy] = useState(false)
  const [help, setHelp] = useState(false)
  const set = (patch: Partial<BuddySettings>) => { const next = { ...b, ...patch }; setB(next); onChange(next) }
  if (!me.whatsapp.buddy) {
    return <p className="help">{me.whatsapp.reminders ? 'Your admin has turned Buddy off.' : 'Buddy needs WhatsApp reminders, which your admin has turned off.'}</p>
  }
  const test = async () => {
    setBusy(true)
    try { await api('/buddy/test', 'POST', { kind }); toast('Sent, check WhatsApp') } catch (e: any) { toast(e.message) }
    setBusy(false)
  }
  const style = STYLES.find((x) => x.key === b.style) || STYLES[0]
  const bot = me.whatsapp.bot
  const fromBot = !!bot && b.via === 'bot' && b.viaChosen
  return (
    <div className="buddy">
      {bot && (
        <div className="field buddy-from">
          <span className="label">Messages come from</span>
          <div className="seg" role="radiogroup" aria-label="Who sends Buddy's messages">
            <button role="radio" aria-checked={!fromBot} className={!fromBot ? 'on' : ''} onClick={() => set({ via: 'self', viaChosen: true })}>Message yourself</button>
            <button role="radio" aria-checked={fromBot} className={fromBot ? 'on' : ''} onClick={() => set({ via: 'bot', viaChosen: true })}>Buddy’s number</button>
          </div>
        </div>
      )}
      {fromBot && bot ? (
        <p className="help buddy-intro">
          Pick <b>💬 WhatsApp me</b> on a task and Buddy messages you from <b>its own number{bot.phone ? ` (${bot.phone})` : ''}</b>.
          Reply in that chat with <b>done</b>, <b>snooze 1h</b> or <b>today</b>.
          <small className="buddy-privacy"> 🔓 Whoever runs that number (your admin) can read these messages and your replies. Pick <b>Message yourself</b> to keep them private.</small>
        </p>
      ) : (
        <p className="help buddy-intro">
          Pick <b>💬 WhatsApp me</b> on a task and Buddy messages you in <b>“Message yourself”</b>.
          Reply there with <b>td done</b> or <b>td snooze 1h</b>.
          {bot && <small className="buddy-privacy"> 🔒 Only you can see these messages.</small>}
        </p>
      )}
      <WaWarning me={me} />
      <div className="field">
        <span className="label">Message length</span>
        <div className="seg" role="radiogroup" aria-label="Buddy's personality">
          {STYLES.map((x) => <button key={x.key} role="radio" aria-checked={b.style === x.key} className={b.style === x.key ? 'on' : ''} onClick={() => set({ style: x.key })}>{x.label}</button>)}
        </div>
        <div className="wa-bubble" aria-label="Example message">{waText(style.sample.replace('Gavin', (me.name || me.username).split(' ')[0]))}</div>
      </div>
      <div className="field">
        <label className="toggle tight">
          <input type="checkbox" checked={b.on} onChange={(e) => set({ on: e.target.checked })} />
          <span>Daily messages <small>(morning brief and evening check-in)</small></span>
        </label>
        {b.on && (
          <div className="buddy-times">
            <label className="buddy-time">
              <input type="checkbox" checked={!!b.morning} onChange={(e) => set({ morning: e.target.checked ? '07:30' : null })} />
              <span>☀️ Morning brief</span>
              <input className="input sm" type="time" value={b.morning || ''} disabled={!b.morning} onChange={(e) => e.target.value && set({ morning: e.target.value })} aria-label="Morning brief time" />
            </label>
            <label className="buddy-time">
              <input type="checkbox" checked={!!b.evening} onChange={(e) => set({ evening: e.target.checked ? '21:00' : null })} />
              <span>🌙 Evening check-in</span>
              <input className="input sm" type="time" value={b.evening || ''} disabled={!b.evening} onChange={(e) => e.target.value && set({ evening: e.target.value })} aria-label="Evening check-in time" />
            </label>
          </div>
        )}
      </div>
      <div className="field">
        <span className="label">Exams and study</span>
        <div className="buddy-times flat">
          <label className="buddy-time">
            <input type="checkbox" checked={b.exams} onChange={(e) => set({ exams: e.target.checked, examsAt: b.examsAt || '20:00' })} />
            <span>📝 The evening before an exam</span>
            <input className="input sm" type="time" value={b.examsAt || ''} disabled={!b.exams} onChange={(e) => e.target.value && set({ examsAt: e.target.value })} aria-label="Exam reminder time" />
          </label>
          <label className="buddy-time">
            <input type="checkbox" checked={!!b.study} onChange={(e) => set({ study: e.target.checked ? '18:00' : null })} />
            <span>📚 Today’s study plan</span>
            <input className="input sm" type="time" value={b.study || ''} disabled={!b.study} onChange={(e) => e.target.value && set({ study: e.target.value })} aria-label="Study plan time" />
          </label>
          <label className="buddy-time">
            <input type="checkbox" checked={b.studyBlocks} onChange={(e) => set({ studyBlocks: e.target.checked })} />
            <span>⏰ When a study block starts</span>
          </label>
        </div>
        <span className="help">Exams come from your school’s timetable. Study blocks get a nudge when you give them a time.</span>
      </div>
      <div className="field">
        <span className="label">Try it</span>
        <span className="row wrap">
          <Select className="input sm" value={kind} onChange={(e) => setKind(e.target.value)} aria-label="Which example">
            <option value="task">A task reminder</option>
            <option value="morning">The morning brief</option>
            <option value="evening">The evening check-in</option>
            <option value="study">Today’s study plan</option>
            <option value="exams">Your next exams</option>
            <option value="help">The command list</option>
          </Select>
          <button className="btn ghost sm" disabled={busy} onClick={test}>{busy ? 'Sending…' : 'Send me an example'}</button>
        </span>
      </div>
      <button type="button" className="linkish" onClick={() => setHelp(!help)} aria-expanded={help}>{help ? 'Hide' : 'Show'} commands</button>
      {help && (
        <dl className="buddy-commands">
          {COMMANDS.map(([c, d]) => <div key={c}><dt><code>{fromBot ? plainCmd(c) : c}</code></dt><dd>{fromBot ? d.replace(/td (done|start)/g, '$1') : d}</dd></div>)}
        </dl>
      )}
    </div>
  )
}

/** Your tasks in Google / Apple Calendar: a private subscription link. */
function CalendarFeedSetting() {
  const [url, setUrl] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const load = (renew = false) => {
    setBusy(true)
    api<{ url: string }>(renew ? '/calendar/renew' : '/calendar', renew ? 'POST' : 'GET', renew ? {} : undefined)
      .then((r) => { setUrl(r.url); if (renew) toast('New link made, the old one no longer works') })
      .catch((e) => toast(e.message))
      .finally(() => setBusy(false))
  }
  const webcal = url ? url.replace(/^https?:/, 'webcal:') : ''
  const copy = () => url && navigator.clipboard?.writeText(url).then(() => toast('Link copied'), () => toast('Couldn’t copy'))
  return (
    <div className="field cal-feed">
      <span className="label">Calendar app</span>
      {!url ? (
        <button className="btn ghost sm" disabled={busy} onClick={() => load()}>Get calendar link</button>
      ) : (
        <>
          <div className="row">
            <input className="input sm" readOnly value={url} onFocus={(e) => e.target.select()} aria-label="Calendar link" />
            <button className="btn ghost sm" onClick={copy}>Copy</button>
          </div>
          <div className="row wrap">
            <a className="btn ghost sm" href={webcal}>Apple Calendar</a>
            <a className="btn ghost sm" href={`https://calendar.google.com/calendar/r?cid=${encodeURIComponent(webcal)}`} target="_blank" rel="noopener">Google Calendar</a>
            <button className="btn quiet sm" disabled={busy} onClick={() => { if (confirm('Make a new link? Calendars using the old one will stop updating.')) load(true) }}>New link</button>
          </div>
          <span className="help">Keep this link private: anyone with it can see your dated tasks. Google can take a few hours to update.</span>
        </>
      )}
    </div>
  )
}
