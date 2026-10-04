import { isHex } from '../listColor'
import { REMIND_OPTIONS, describeRemind } from '../dates'
import { useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react'
import { LIST_COLORS, type Appearance, type BuddySettings, type BuddyStyle, type List, type ListColor, type Me } from '../types'
import { AppearanceSettings, HexInput } from './AppearanceSettings'
import type { Prefs, Theme } from '../prefs'
import { disablePush, enablePush, pushEnabledHere, pushSupport, supportMessage, testPush } from '../push'
import { toast } from './Toast'
import { api } from '../api'

/**
 * A modal window. Only the person closes it (Esc, backdrop, a button): we never
 * call close() ourselves, because React's StrictMode (npm run dev) runs effects
 * twice and a close() there fired `onClose` and shut the dialog as it opened.
 */
function Dialog({ title, onClose, children, className = '', closeButton = false }: { title: string; onClose: () => void; children: ReactNode; className?: string; closeButton?: boolean }) {
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
            <span className="help">Pick one of the colours, or tap <b>+</b> for any colour you like.</span>
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
            <span className="help">Signed in as <b>{me.username}</b>, your Whats Up account. Only you can see your tasks.</span>
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
          <span className="label">Tasks display</span>
          <label className="toggle tight">
            <input type="checkbox" checked={prefs.showProgress} onChange={(e) => setPrefs({ showProgress: e.target.checked })} />
            <span>Show progress bars <small>(the red/yellow/green bar on each page and under each task)</small></span>
          </label>
          <label className="toggle tight">
            <input type="checkbox" checked={prefs.showStatus} onChange={(e) => setPrefs({ showStatus: e.target.checked })} />
            <span>Show status labels <small>(Not started · In progress · Completed)</small></span>
          </label>
          <label className="toggle tight">
            <input type="checkbox" checked={prefs.celebrate} onChange={(e) => setPrefs({ celebrate: e.target.checked })} />
            <span>Celebrate when I finish a task 🎉</span>
          </label>
        </div>
        <div className="field">
          <span className="label">Default early reminder</span>
          <select className="input" value={prefs.defaultRemind === null ? 'none' : String(prefs.defaultRemind)} onChange={(e) => setPrefs({ defaultRemind: e.target.value === 'none' ? null : Number(e.target.value) })} aria-label="Default early reminder">
            {REMIND_OPTIONS.map((o) => <option key={String(o.value)} value={o.value === null ? 'none' : String(o.value)}>{o.value === null ? 'No reminder' : o.label}</option>)}
            {prefs.defaultRemind !== null && !REMIND_OPTIONS.some((o) => o.value === prefs.defaultRemind) && <option value={String(prefs.defaultRemind)}>{describeRemind(prefs.defaultRemind)}</option>}
          </select>
          <span className="help">Given to a task when you first set its time. Any task can have its own, including a custom one (🔔 → Custom…).</span>
        </div>
      </section>

      <section className="set-section">
        <h3 className="set-title">Calendar</h3>
        <div className="field">
          <span className="label">Public holidays on the calendar</span>
          <select className="input" value={me.holidayCountry} onChange={(e) => onHolidayCountry(e.target.value)} aria-label="Public holidays country">
            <option value="off">Don’t show holidays</option>
            {me.holidayCountries.map((c) => <option key={c.code} value={c.code}>{c.name}</option>)}
          </select>
          <span className="help">Holiday days are shaded red, with their name.</span>
        </div>
        <div className="field">
          <span className="label">Calendar weeks start on</span>
          <div className="seg" role="radiogroup" aria-label="Week start">
            <button role="radio" aria-checked={prefs.weekStartsMonday} className={prefs.weekStartsMonday ? 'on' : ''} onClick={() => setPrefs({ weekStartsMonday: true })}>Monday</button>
            <button role="radio" aria-checked={!prefs.weekStartsMonday} className={!prefs.weekStartsMonday ? 'on' : ''} onClick={() => setPrefs({ weekStartsMonday: false })}>Sunday</button>
          </div>
        </div>
      </section>

      <section className="set-section">
        <h3 className="set-title">Notifications</h3>
        <NotificationsSetting />
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
            <button type="button" className="btn ghost" onClick={onTour}>▶ Start the tutorial</button>
            <span className="help">A quick tour of every part of the app. Next, Back or Skip whenever you like.</span>
          </span>
        </div>
        <p className="help about">Version {me.version} · Your name, appearance and holidays follow your account; the other settings are saved on this device.</p>
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
  const blocked = support === 'ok' && Notification.permission === 'denied'
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
        <p className="help">Notifications are blocked for this site. Allow them in your browser's site settings (the 🔒 next to the address), then come back here.</p>
      ) : on ? (
        <>
          <span className="badge ok"><i className="dot" />On: reminders pop up even when the site is closed</span>
          <div className="row wrap notif-actions">
            <button className="btn ghost sm" disabled={busy} onClick={() => run(testPush, () => toast('Test sent. It should pop up in a moment 🔔'))}>Send test notification</button>
            <button className="btn quiet sm" disabled={busy} onClick={() => run(disablePush, () => setOn(false))}>Turn off</button>
          </div>
        </>
      ) : (
        <>
          <p className="help">Get a pop-up for each reminder, like a message, even when this site is closed.</p>
          <button className="btn" disabled={busy || on === null} onClick={() => run(enablePush, () => { setOn(true); toast('Notifications are on 🔔') })}>
            {busy ? 'Turning on…' : 'Turn on notifications'}
          </button>
        </>
      )}
      {msg && <p className="error" role="alert">{msg}</p>}
    </div>
  )
}

/** Where Buddy's messages land, in a few words. */
const waWhere = (me: Me) => me.whatsapp.botNumber && me.whatsapp.bot
  ? `from Buddy (${me.whatsapp.bot.phone || 'its own number'}) to your WhatsApp${me.whatsapp.phone ? ` ${me.whatsapp.phone}` : ''}`
  : 'your “Message yourself” chat'

/** Not linked yet / the bot's phone is offline: said once, where it matters. */
function WaWarning({ me }: { me: Me }) {
  if (!me.whatsapp.linked) return <p className="help warn-text">⚠️ Link your WhatsApp first: open your chats in Whats Up and scan the QR code. Until then nothing can reach you on WhatsApp.</p>
  if (me.whatsapp.botNumber && me.whatsapp.bot && !me.whatsapp.bot.connected) return <p className="help warn-text">⚠️ Buddy’s own number is offline right now, so its messages go to your “Message yourself” chat until it’s back.</p>
  return null
}

/** Reminders on WhatsApp: from the Buddy bot when the admin set one up, else your "Message yourself" chat. */
function WhatsAppSetting({ me, on, onChange }: { me: Me; on: boolean; onChange: (on: boolean) => void }) {
  const [busy, setBusy] = useState(false)
  const bot = me.whatsapp.botNumber
  return (
    <div className="field">
      <span className="label">WhatsApp</span>
      <label className="toggle tight">
        <input type="checkbox" checked={on} onChange={(e) => onChange(e.target.checked)} />
        <span>Also send my reminders to WhatsApp <small>({waWhere(me)})</small></span>
      </label>
      <WaWarning me={me} />
      {me.whatsapp.inbox && (bot
        ? <p className="help">Tip: message Buddy <b>add buy milk tomorrow 5pm</b> to add a task, or <b>today</b> to see today’s.</p>
        : <p className="help">Tip: message yourself <b>todo: buy milk tomorrow 5pm</b> on WhatsApp to add a task, or <b>todo?</b> to see today’s.</p>)}
      {on && (
        <button className="btn ghost sm" disabled={busy} onClick={async () => {
          setBusy(true)
          try { await api('/wa/test-reminder', 'POST', {}); toast('Sent. Check your WhatsApp 💬') } catch (e: any) { toast(e.message) }
          setBusy(false)
        }}>Send a test to my WhatsApp</button>
      )}
    </div>
  )
}

const STYLES: { key: BuddyStyle; label: string; sample: string }[] = [
  { key: 'friendly', label: '😊 Friendly', sample: 'Hey Gavin! 👋 Just a little nudge about this one: *Physics lab report* (in 2 h). You’ve got this 🌟' },
  { key: 'coach', label: '💪 Coach', sample: 'Let’s go, Gavin! 💪 Time to crush this: *Physics lab report* (in 2 h). Start now, thank yourself later 🔥' },
  { key: 'short', label: '⚡ Short', sample: '⏰ *Physics lab report* · Today, 4:00 PM (in 2 h)' },
]
/** "td done" → "done" for the bot's chat, where you just reply (same rules as the server's plain()). */
const plainCmd = (c: string) => c.replace(/^td\?$/, 'today').replace(/^td:\s?/, 'add ').replace(/^td /, '')
const COMMANDS: [string, string][] = [
  ['td?', 'today’s list, numbered'],
  ['td done', 'finish the task Buddy just reminded you about (td done 2: number 2 on its list)'],
  ['td start', 'mark it in progress'],
  ['td snooze 30m', 'or 2h, tonight, tomorrow, 3pm'],
  ['td step', 'tick its next step'],
  ['td move', 'push today’s unfinished tasks to tomorrow'],
  ['td remind me to call mum at 8pm', 'a task and a WhatsApp reminder in one go'],
  ['td: buy milk tomorrow 5pm', 'just add a task'],
  ['td help', 'this list, in WhatsApp'],
]

/** WhatsApp Buddy: its personality, the daily messages, an example on demand, and what you can answer. */
function BuddySetting({ me, onChange }: { me: Me; onChange: (b: BuddySettings) => void }) {
  const [b, setB] = useState<BuddySettings>(me.buddy)
  const [kind, setKind] = useState('task')
  const [busy, setBusy] = useState(false)
  const [help, setHelp] = useState(false)
  const set = (patch: Partial<BuddySettings>) => { const next = { ...b, ...patch }; setB(next); onChange(next) }
  if (!me.whatsapp.buddy) {
    return <p className="help">{me.whatsapp.reminders ? 'Your admin has turned WhatsApp Buddy off.' : 'WhatsApp Buddy needs WhatsApp reminders, which your admin has turned off.'}</p>
  }
  const test = async () => {
    setBusy(true)
    try { await api('/buddy/test', 'POST', { kind }); toast('Sent. Check your WhatsApp 💬') } catch (e: any) { toast(e.message) }
    setBusy(false)
  }
  const style = STYLES.find((x) => x.key === b.style) || STYLES[0]
  return (
    <div className="buddy">
      {me.whatsapp.botNumber && me.whatsapp.bot ? (
        <p className="help buddy-intro">
          A little bot that messages you on your real WhatsApp. Choose <b>💬 WhatsApp me</b> on any task and Buddy writes to you about it
          from <b>its own number{me.whatsapp.bot.phone ? ` (${me.whatsapp.bot.phone})` : ''}</b>, so your phone buzzes like any other message, even when Whats Up isn’t open.
          Save it as a contact (“Buddy 🤖”), and answer right in that chat: <b>done</b>, <b>snooze 1h</b>, <b>today</b>…
          <small className="buddy-privacy"> Like any WhatsApp chat, what Buddy sends you also shows on the bot’s own phone, which your admin looks after.</small>
        </p>
      ) : (
        <p className="help buddy-intro">
          A little bot in your WhatsApp. Choose <b>💬 WhatsApp me</b> on any task and Buddy messages you about it in your <b>“Message yourself”</b> chat.
          Answer it there with <b>td done</b>, <b>td snooze 1h</b> and more.
        </p>
      )}
      <WaWarning me={me} />
      <div className="field">
        <span className="label">Personality</span>
        <div className="seg" role="radiogroup" aria-label="Buddy's personality">
          {STYLES.map((x) => <button key={x.key} role="radio" aria-checked={b.style === x.key} className={b.style === x.key ? 'on' : ''} onClick={() => set({ style: x.key })}>{x.label}</button>)}
        </div>
        <div className="wa-bubble" aria-label="Example message">{style.sample.replace('Gavin', (me.name || me.username).split(' ')[0]).split('*').map((part, i) => (i % 2 ? <b key={i}>{part}</b> : part))}</div>
      </div>
      <div className="field">
        <label className="toggle tight">
          <input type="checkbox" checked={b.on} onChange={(e) => set({ on: e.target.checked })} />
          <span>Daily messages <small>(a morning brief of what’s due and an evening check-in; reply <b>td done 2</b> or <b>td move</b>)</small></span>
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
        <span className="label">Try it</span>
        <span className="row wrap">
          <select className="input sm" value={kind} onChange={(e) => setKind(e.target.value)} aria-label="Which example">
            <option value="task">A task reminder</option>
            <option value="morning">The morning brief</option>
            <option value="evening">The evening check-in</option>
            <option value="help">The command list</option>
          </select>
          <button className="btn ghost sm" disabled={busy} onClick={test}>{busy ? 'Sending…' : 'Send me an example'}</button>
        </span>
      </div>
      <button type="button" className="linkish" onClick={() => setHelp(!help)} aria-expanded={help}>{help ? 'Hide' : 'Show'} what you can answer</button>
      {help && (
        <dl className="buddy-commands">
          {COMMANDS.map(([c, d]) => <div key={c}><dt><code>{me.whatsapp.botNumber ? plainCmd(c) : c}</code></dt><dd>{me.whatsapp.botNumber ? d.replace(/td (done|start)/g, '$1') : d}</dd></div>)}
        </dl>
      )}
    </div>
  )
}
