/** The Todolist's little logo. (Signing in happens on Whats Up's own page now.) */
export function Mark({ size = 52, inverse = false }: { size?: number; inverse?: boolean }) {
  return (
    <span className="mark" style={{ width: size, height: size }}>
      <svg viewBox="0 0 48 48" aria-hidden="true">
        {/* an open ring (a G, for Gavin) with the tick swinging out through the gap */}
        <rect x="3" y="3" width="42" height="42" rx="13" fill={inverse ? '#f3f7f5' : 'var(--leaf)'} />
        <path d="M33.4 15.4A12.4 12.4 0 1 0 36.4 24.6" fill="none" stroke={inverse ? '#5865f2' : 'var(--leaf-ink)'} strokeOpacity=".55" strokeWidth="3.6" strokeLinecap="round" />
        <path d="M17.6 24.2 22.5 29.1 36.6 14.9" fill="none" stroke={inverse ? '#5865f2' : 'var(--leaf-ink)'} strokeWidth="4.4" strokeLinecap="round" strokeLinejoin="round" />
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
