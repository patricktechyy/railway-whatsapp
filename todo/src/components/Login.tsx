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
