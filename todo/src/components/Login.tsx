/** The Todolist's little logo. (Signing in happens on Whats Up's own page now.) */
export function Mark({ size = 52, inverse = false }: { size?: number; inverse?: boolean }) {
  return (
    <span className="mark" style={{ width: size, height: size }}>
      <svg viewBox="0 0 48 48" aria-hidden="true">
        <rect x="4" y="4" width="40" height="40" rx="12" fill={inverse ? '#f3f7f5' : 'var(--leaf)'} />
        <path d="M15 24.5 21.5 31 33.5 18" fill="none" stroke={inverse ? '#17805a' : 'var(--leaf-ink)'} strokeWidth="4.4" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    </span>
  )
}

/** Whats Up's logo: its upside-down speech bubble with the ^ (the same mark Whats Up uses), in Whats Up green. */
export function WhatsUpLogo({ size = 20, className = '' }: { size?: number; className?: string }) {
  return (
    <svg className={`wa-mark${className ? ` ${className}` : ''}`} viewBox="0 0 48 48" width={size} height={size} aria-hidden="true">
      <path fill="#17805a" d="M15 3.5 L22.5 13 H33 A11 11 0 0 1 44 24 V31 A11 11 0 0 1 33 42 H15 A11 11 0 0 1 4 31 V24 A11 11 0 0 1 11.5 13.4 Z" />
      <path d="M16 31.5 24 23.5 32 31.5" fill="none" stroke="#ffffff" strokeWidth="4.2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}
