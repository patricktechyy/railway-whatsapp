import type { Appearance, BasePreset, CustomKey, CustomLook, Gradient } from './types'

/**
 * The look: one of the ready-made styles (Discord, Mono + Blue, Classic green)
 * or your own Custom one. Custom starts from a style and overrides any of its
 * colours; it's remembered on your account even while another style is on.
 * Colours become CSS variables on the page, and text drawn on top of them is
 * picked automatically (dark or white) so it stays readable.
 */

export const DEFAULT_APPEARANCE: Appearance = { preset: 'discord', sidebar: null, accent: null, button: null, taskBg: null, custom: null, personalize: null }

/** Ready-made gradients for the Personalize It button and page. */
export const GRADIENTS: { name: string; g: Gradient }[] = [
  { name: 'Sunset', g: { from: '#ff7e5f', to: '#feb47b', angle: 135 } },
  { name: 'Ocean', g: { from: '#2193b0', to: '#6dd5ed', angle: 135 } },
  { name: 'Aurora', g: { from: '#00c9a7', to: '#845ec2', angle: 135 } },
  { name: 'Candy', g: { from: '#ff5f9e', to: '#a855f7', angle: 135 } },
  { name: 'Forest', g: { from: '#134e5e', to: '#71b280', angle: 135 } },
  { name: 'Midnight', g: { from: '#232526', to: '#5865f2', angle: 135 } },
]
const mixHex = (a: string, b: string) => '#' + [1, 3, 5].map((i) => Math.round((parseInt(a.slice(i, i + 2), 16) + parseInt(b.slice(i, i + 2), 16)) / 2).toString(16).padStart(2, '0')).join('')

export const PRESET_LABEL = { discord: 'Discord', mono: 'Mono + Blue', classic: 'Classic green', custom: 'Custom' } as const
export const CUSTOM_KEYS: CustomKey[] = ['sidebar', 'accent', 'button', 'taskBg', 'page', 'card', 'text']
export const emptyCustom = (base: BasePreset = 'discord'): CustomLook => ({ base, sidebar: null, accent: null, button: null, taskBg: null, page: null, card: null, text: null })

/** What each colour looks like in each style (light mode), for the pickers' starting values. */
export const PRESET_DEFAULTS: Record<BasePreset, Record<CustomKey, string>> = {
  discord: { sidebar: '#2b2d31', accent: '#5865f2', button: '#5865f2', taskBg: '#ffffff', page: '#ffffff', card: '#ffffff', text: '#313338' },
  mono: { sidebar: '#2563eb', accent: '#2563eb', button: '#0a0a0a', taskBg: '#ffffff', page: '#f4f4f5', card: '#ffffff', text: '#0a0a0a' },
  classic: { sidebar: '#ffffff', accent: '#17805a', button: '#17805a', taskBg: '#ffffff', page: '#f3f7f5', card: '#ffffff', text: '#13241f' },
}

const hexToRgb = (h: string) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16))
function luminance(hex: string) {
  const [r, g, b] = hexToRgb(hex).map((v) => {
    const c = v / 255
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
  })
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}
export const contrast = (a: string, b: string) => {
  const [x, y] = [luminance(a), luminance(b)].sort((m, n) => n - m)
  return (x + 0.05) / (y + 0.05)
}
/** Dark or white text, whichever reads better on this background. */
export const inkOn = (bg: string) => (contrast(bg, '#ffffff') >= contrast(bg, '#0a0a0a') ? '#ffffff' : '#0a0a0a')
const shade = (hex: string, amt: number) =>
  '#' + hexToRgb(hex).map((v) => Math.max(0, Math.min(255, Math.round(v + amt * (amt < 0 ? v : 255 - v)))).toString(16).padStart(2, '0')).join('')

/**
 * The appearance with older shapes brought up to date: colours picked on top
 * of a style (v1.5–1.6) become a Custom look, so they look exactly the same.
 */
export function effective(a: Appearance | null | undefined): Appearance {
  const x: Appearance = { ...DEFAULT_APPEARANCE, ...(a || {}) }
  const legacy = x.sidebar || x.accent || x.button || x.taskBg
  if (legacy || (x.preset === 'custom' && !x.custom)) {
    const base: BasePreset = x.preset === 'custom' ? 'mono' : x.preset
    return { preset: 'custom', sidebar: null, accent: null, button: null, taskBg: null, personalize: x.personalize ?? null, custom: { ...emptyCustom(base), ...(x.custom || {}), base: x.custom?.base || base, sidebar: x.sidebar, accent: x.accent, button: x.button, taskBg: x.taskBg } }
  }
  return x
}

/** The style underneath: the chosen one, or the one Custom starts from. */
export const basePreset = (a: Appearance): BasePreset => (a.preset === 'custom' ? a.custom?.base || 'discord' : a.preset)

/** Put an appearance on the page. */
export function applyAppearance(input: Appearance | null | undefined) {
  const app = effective(input)
  const c: Partial<CustomLook> = app.preset === 'custom' && app.custom ? app.custom : {}
  const root = document.documentElement
  root.dataset.preset = basePreset(app)
  const set = (k: string, v: string | null | undefined) => (v ? root.style.setProperty(k, v) : root.style.removeProperty(k))

  const side = c.sidebar
  set('--side-bg', side)
  set('--side-ink', side && inkOn(side))
  set('--side-muted', side && (inkOn(side) === '#ffffff' ? 'rgba(255,255,255,.74)' : 'rgba(10,10,10,.62)'))
  set('--side-hover', side && (inkOn(side) === '#ffffff' ? 'rgba(255,255,255,.14)' : 'rgba(10,10,10,.07)'))
  set('--side-on', side && (inkOn(side) === '#ffffff' ? 'rgba(255,255,255,.24)' : 'rgba(10,10,10,.1)'))
  set('--side-on-ink', side && inkOn(side))
  set('--side-line', side && (inkOn(side) === '#ffffff' ? 'rgba(255,255,255,.14)' : 'rgba(10,10,10,.1)'))
  set('--side-mark-bg', side && inkOn(side))
  set('--side-mark-ink', side)

  set('--leaf', c.accent)
  set('--leaf-strong', c.accent && shade(c.accent, -0.18))
  set('--leaf-ink', c.accent && inkOn(c.accent))
  set('--leaf-soft', c.accent && `color-mix(in srgb, ${c.accent} 16%, var(--surface))`)

  set('--btn-bg', c.button)
  set('--btn-strong', c.button && shade(c.button, inkOn(c.button) === '#ffffff' ? 0.16 : -0.12))
  set('--btn-ink', c.button && inkOn(c.button))

  // page, cards and text: the rest of the palette is worked out from them
  const card = c.card, text = c.text ?? (card ? inkOn(card) === '#ffffff' ? '#f2f3f5' : '#1f2023' : null)
  set('--paper', c.page)
  set('--surface', card)
  set('--ink', text)
  set('--muted', text && `color-mix(in srgb, ${text} 64%, var(--surface))`)
  set('--line', (card || text) ? 'color-mix(in srgb, var(--ink) 14%, var(--surface))' : null)
  set('--field', (card || text) ? 'color-mix(in srgb, var(--ink) 6%, var(--surface))' : null)
  set('--hover', (card || text) ? 'color-mix(in srgb, var(--ink) 9%, var(--surface))' : null)
  const dark = card ? inkOn(card) === '#ffffff' : c.page ? inkOn(c.page) === '#ffffff' : null
  set('color-scheme', dark === null ? null : dark ? 'dark' : 'light')

  // task cards: your colour, or the cards' colour when only that was chosen
  const taskBg = c.taskBg || card
  set('--task-bg', taskBg)
  if (c.taskBg) root.dataset.taskBg = ''
  else delete root.dataset.taskBg
  const taskInk = c.taskBg ? inkOn(c.taskBg) : text
  set('--task-ink', taskInk)
  set('--task-muted', taskInk && (c.taskBg ? (inkOn(c.taskBg) === '#ffffff' ? 'rgba(255,255,255,.78)' : 'rgba(10,10,10,.62)') : `color-mix(in srgb, ${taskInk} 64%, var(--task-bg))`))

  // the Personalize It gradient
  const pz = app.personalize
  set('--pz-from', pz?.from)
  set('--pz-to', pz?.to)
  set('--pz-angle', pz ? `${pz.angle}deg` : null)
  set('--pz-ink', pz && inkOn(mixHex(pz.from, pz.to)))

  // phone status bar / browser chrome follows the sidebar
  const meta = document.querySelector('meta[name="theme-color"]')
  meta?.setAttribute('content', side || { discord: '#2b2d31', classic: '#17805a', mono: '#2563eb' }[basePreset(app)])
}
