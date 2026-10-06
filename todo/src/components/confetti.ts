/** A little burst of celebration when a task is finished. Respects reduced motion. */
const BITS = ['🎉', '✨', '✅', '💚', '🌟', '🥳']

export function celebrate(x = window.innerWidth / 2, y = window.innerHeight / 2, count = 18) {
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) return
  for (let i = 0; i < count; i++) {
    const s = document.createElement('span')
    s.className = 'burst-bit'
    s.textContent = BITS[(Math.random() * BITS.length) | 0]
    const angle = Math.random() * Math.PI * 2
    const dist = 50 + Math.random() * 90
    s.style.left = `${x}px`
    s.style.top = `${y}px`
    s.style.setProperty('--dx', `${Math.cos(angle) * dist}px`)
    s.style.setProperty('--dy', `${Math.sin(angle) * dist - 40}px`)
    s.style.setProperty('--r', `${Math.random() * 360 - 180}deg`)
    s.style.fontSize = `${12 + Math.random() * 12}px`
    document.body.appendChild(s)
    setTimeout(() => s.remove(), 1000)
  }
}

/** The big one: everything due today is done. */
export function rain() {
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) return
  for (let i = 0; i < 46; i++) {
    const s = document.createElement('span')
    s.className = 'rain-bit'
    s.textContent = BITS[(Math.random() * BITS.length) | 0]
    s.style.left = `${Math.random() * 100}vw`
    s.style.fontSize = `${14 + Math.random() * 20}px`
    s.style.setProperty('--r', `${Math.random() * 900 - 450}deg`)
    s.style.animationDuration = `${2.2 + Math.random() * 2.4}s`
    s.style.animationDelay = `${Math.random() * 0.6}s`
    document.body.appendChild(s)
    setTimeout(() => s.remove(), 5600)
  }
}
