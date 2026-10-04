import { useEffect, useState } from 'react'
import { CUSTOM_KEYS, GRADIENTS, PRESET_DEFAULTS, PRESET_LABEL, applyAppearance, basePreset, contrast, effective, emptyCustom, inkOn } from '../appearance'
import type { Appearance, BasePreset, CustomKey, CustomLook, Gradient } from '../types'

const FIELDS: Record<CustomKey, { label: string; help: string }> = {
  sidebar: { label: 'Sidebar', help: 'The menu on the left' },
  accent: { label: 'Accent', help: 'Links, highlights, switches, selected items' },
  button: { label: 'Buttons', help: 'Add, Save, Done…' },
  taskBg: { label: 'Task cards', help: 'The cards your tasks sit on' },
  page: { label: 'Page background', help: 'Behind everything' },
  card: { label: 'Panels & cards', help: 'Boxes, dialogs, blocks' },
  text: { label: 'Text', help: 'The main writing colour' },
}
const DIRECTIONS = [{ a: 90, label: '→', name: 'Left to right' }, { a: 135, label: '↘', name: 'Diagonal down' }, { a: 180, label: '↓', name: 'Top to bottom' }, { a: 45, label: '↗', name: 'Diagonal up' }]
const DEFAULT_PZ: Gradient = { from: '#7c83f7', to: '#a855f7', angle: 135 }
const gradientCss = (g: Gradient) => `linear-gradient(${g.angle}deg, ${g.from}, ${g.to})`

/** The Personalize It button and page colours: ready-made gradients or your own two colours. */
function PersonalizeColors({ value, onChange }: { value: Gradient | null | undefined; onChange: (g: Gradient | null) => void }) {
  const g = value || DEFAULT_PZ
  const same = (x: Gradient) => value && x.from === value.from && x.to === value.to
  return (
    <div className="pz-settings">
      <span className="label">✨ Personalize It colours</span>
      <div className="pz-row">
        <span className="pz-preview" style={{ background: gradientCss(g), color: inkOn(g.from) }}>✨ Personalize It</span>
        <button type="button" className="btn quiet sm" disabled={!value} onClick={() => onChange(null)}>Reset</button>
      </div>
      <div className="pz-chips" role="radiogroup" aria-label="Ready-made gradients">
        {GRADIENTS.map(({ name, g: x }) => (
          <button key={name} type="button" role="radio" aria-checked={!!same(x)} className={`pz-chip${same(x) ? ' on' : ''}`} style={{ background: gradientCss(x) }}
            onClick={() => onChange({ ...x, angle: value?.angle ?? x.angle })} title={name}><span>{name}</span></button>
        ))}
      </div>
      <ul className="color-fields pz-fields">
        {(['from', 'to'] as const).map((k) => (
          <li key={k}>
            <label className="color-swatch" style={{ background: g[k], color: inkOn(g[k]) }}>
              <input type="color" value={g[k]} onChange={(e) => onChange({ ...g, [k]: e.target.value.toLowerCase() })} aria-label={`Gradient ${k} colour`} />
              Aa
            </label>
            <span className="color-text"><b>{k === 'from' ? 'From' : 'To'}</b><small>{k === 'from' ? 'Where the gradient starts' : 'Where it ends'}</small></span>
            <HexInput value={value ? value[k] : null} placeholder={g[k]} label={`Gradient ${k}`} onChange={(v) => v && onChange({ ...g, [k]: v })} />
          </li>
        ))}
      </ul>
      <div className="row wrap pz-dir">
        <span className="help">Direction</span>
        <div className="seg sm" role="radiogroup" aria-label="Gradient direction">
          {DIRECTIONS.map((d) => (
            <button key={d.a} type="button" role="radio" aria-checked={g.angle === d.a} className={g.angle === d.a ? 'on' : ''} aria-label={d.name} title={d.name} onClick={() => onChange({ ...g, angle: d.a })}>{d.label}</button>
          ))}
        </div>
      </div>
    </div>
  )
}

const BASES: BasePreset[] = ['discord', 'mono', 'classic']
const STYLES = [...BASES, 'custom'] as const

/**
 * Settings → Appearance. Pick a ready-made style, or Custom: start from a
 * style and change any of its colours. Your Custom colours are saved to your
 * account and come back when you switch to Custom again.
 */
export function AppearanceSettings({ value, onChange }: { value: Appearance | null; onChange: (a: Appearance) => void }) {
  const [a, setA] = useState<Appearance>(() => effective(value))
  const custom: CustomLook = a.custom || emptyCustom(basePreset(a))
  const base = PRESET_DEFAULTS[custom.base]

  const update = (next: Appearance) => {
    setA(next)
    applyAppearance(next) // live preview
    onChange(next) // saved (debounced by the caller)
  }
  const pick = (p: (typeof STYLES)[number]) =>
    update({ ...a, sidebar: null, accent: null, button: null, taskBg: null, preset: p, custom: p === 'custom' ? custom : a.custom || null })
  const setCustom = (patch: Partial<CustomLook>) => update({ ...a, preset: 'custom', custom: { ...custom, ...patch } })

  const cardNow = custom.card || base.card
  const textNow = custom.text || (custom.card ? inkOn(custom.card) : base.text)
  const hardToRead = a.preset === 'custom' && (custom.card || custom.text) && contrast(cardNow, textNow) < 4.5

  return (
    <div className="field appearance">
      <span className="label">Appearance</span>
      <div className="seg" role="radiogroup" aria-label="Style">
        {STYLES.map((p) => (
          <button key={p} type="button" role="radio" aria-checked={a.preset === p} className={a.preset === p ? 'on' : ''} onClick={() => pick(p)}>
            {p === 'custom' ? '🎨 Custom' : PRESET_LABEL[p]}
          </button>
        ))}
      </div>

      {a.preset !== 'custom' ? (
        <div className="row wrap preset-note">
          <span className="help">
            {a.preset === 'discord' ? 'Discord’s greys with blurple buttons.' : a.preset === 'mono' ? 'Black & white with a blue sidebar.' : 'The original green look.'}
            {' '}Follows light / dark mode.
            {a.custom && CUSTOM_KEYS.some((k) => a.custom![k]) && <> Your Custom colours are saved: pick <b>🎨 Custom</b> to use them again.</>}
          </span>
          <span className="spacer" />
          <button type="button" className="btn ghost sm" onClick={() => update({ ...a, preset: 'custom', custom: a.custom ? a.custom : emptyCustom(a.preset as BasePreset) })}>
            {a.custom ? 'Use my Custom look' : 'Customize this look…'}
          </button>
        </div>
      ) : (
        <>
          <div className="row wrap custom-base">
            <span className="help">Start from</span>
            <div className="seg sm" role="radiogroup" aria-label="Start from">
              {BASES.map((b) => (
                <button key={b} type="button" role="radio" aria-checked={custom.base === b} className={custom.base === b ? 'on' : ''} onClick={() => setCustom({ base: b })}>{PRESET_LABEL[b]}</button>
              ))}
            </div>
          </div>
          <ul className="color-fields">
            {CUSTOM_KEYS.map((k) => {
              const cur = custom[k] || (k === 'text' && custom.card ? inkOn(custom.card) : base[k])
              return (
                <li key={k}>
                  <label className="color-swatch" style={{ background: cur, color: inkOn(cur) }}>
                    <input type="color" value={cur} onChange={(e) => setCustom({ [k]: e.target.value.toLowerCase() })} aria-label={`${FIELDS[k].label} colour`} />
                    Aa
                  </label>
                  <span className="color-text"><b>{FIELDS[k].label}</b><small>{FIELDS[k].help}</small></span>
                  <HexInput value={custom[k]} placeholder={custom[k] ? '' : 'style’s own'} label={FIELDS[k].label} onChange={(v) => setCustom({ [k]: v })} />
                  <button type="button" className="btn quiet sm" disabled={!custom[k]} onClick={() => setCustom({ [k]: null })}>Reset</button>
                </li>
              )
            })}
          </ul>
          {hardToRead && <p className="help warn-text">⚠️ The text may be hard to read on these panels. Try a darker text or a lighter panel colour.</p>}
          <div className="row wrap">
            <span className="help">Saved to your account. Colours you leave as “style’s own” still follow light / dark mode; status colours (red, yellow, green) never change.</span>
            <span className="spacer" />
            <button type="button" className="btn ghost sm" onClick={() => setCustom({ ...emptyCustom(custom.base) })}>Reset custom</button>
          </div>
        </>
      )}
      <PersonalizeColors value={a.personalize} onChange={(g) => update({ ...a, personalize: g })} />
    </div>
  )
}

/** A #rrggbb box you can type into freely; it only applies complete codes. */
export function HexInput({ value, placeholder, label, onChange }: { value: string | null; placeholder: string; label: string; onChange: (v: string | null) => void }) {
  const [draft, setDraft] = useState(value || '')
  useEffect(() => setDraft(value || ''), [value])
  const bad = !!draft && !/^#?[0-9a-f]{6}$/i.test(draft.trim())
  return (
    <input
      className="input sm hex"
      value={draft}
      placeholder={placeholder}
      maxLength={7}
      aria-label={`${label} colour code`}
      aria-invalid={bad || undefined}
      onChange={(e) => {
        const v = e.target.value.trim()
        setDraft(e.target.value)
        if (/^#?[0-9a-f]{6}$/i.test(v)) onChange(`#${v.replace('#', '').toLowerCase()}`)
        else if (!v) onChange(null)
      }}
      onBlur={() => setDraft(value || '')}
    />
  )
}
