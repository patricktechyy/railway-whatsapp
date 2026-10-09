import type { ReactNode } from 'react'

/**
 * The app's own icons, drawn on the same 20 px grid with the same rounded
 * 1.7 stroke as the sidebar's. They stand in for the emoji the interface used
 * to use, so marks look like one set and follow the text colour. Emoji people
 * pick themselves (list and group icons, notes) stay emoji: that's content.
 */
const dot = (cx: number, cy: number) => <circle cx={cx} cy={cy} r=".95" fill="currentColor" stroke="none" />
const PATHS = {
  sun: <><circle cx="10" cy="10" r="3.2" /><path d="M10 2.5v1.8M10 15.7v1.8M2.5 10h1.8M15.7 10h1.8M4.7 4.7l1.3 1.3M14 14l1.3 1.3M4.7 15.3 6 14M14 6l1.3-1.3" /></>,
  moon: <path d="M15.8 12.4A6.6 6.6 0 0 1 7.6 4.2a6.6 6.6 0 1 0 8.2 8.2z" />,
  note: <><path d="M5.5 2.5h6l3 3v12h-9z" /><path d="M11.5 2.5v3h3M8 10h4.5M8 13.5h4.5" /></>,
  book: <><path d="M10 5.5c-1.8-1.3-4-1.8-6.5-1.5v11c2.5-.3 4.7.2 6.5 1.5 1.8-1.3 4-1.8 6.5-1.5v-11c-2.5-.3-4.7.2-6.5 1.5z" /><path d="M10 5.5v11" /></>,
  clock: <><circle cx="10" cy="10.8" r="6.3" /><path d="M10 7.6v3.4l2.2 1.5M3.6 4.4 5.2 3M16.4 4.4 14.8 3" /></>,
  lock: <><rect x="4.5" y="9" width="11" height="8.5" rx="2" /><path d="M7 9V6.5a3 3 0 0 1 6 0V9" /></>,
  unlock: <><rect x="4.5" y="9" width="11" height="8.5" rx="2" /><path d="M7 9V6.5a3 3 0 0 1 5.8-1.1" /></>,
  pin: <path d="M7 2.8h6M8.2 2.8v5L5.6 11.5h8.8L11.8 7.8v-5M10 11.5v5.7" />,
  chat: <path d="M4.2 4h11.6c.9 0 1.7.8 1.7 1.7v7.1c0 .9-.8 1.7-1.7 1.7H9.4L5.6 17.3v-2.8H4.2c-.9 0-1.7-.8-1.7-1.7V5.7C2.5 4.8 3.3 4 4.2 4z" />,
  bell: <path d="M5.2 13.8V9a4.8 4.8 0 0 1 9.6 0v4.8l1.5 1.5H3.7zM8.3 17.6a1.9 1.9 0 0 0 3.4 0" />,
  megaphone: <path d="M3 8.3v3.4h3l7.5 4.3V4L6 8.3zM6 11.7l1 4.6h2.1l-.8-3.8M15.8 7.9a2.4 2.4 0 0 1 0 4.2" />,
  flag: <path d="M5 17.5V3M5 3.6h9.8l-2.1 3.5 2.1 3.5H5" />,
  star: <path d="m10 2.9 2.2 4.5 4.9.7-3.6 3.4.9 4.9L10 14l-4.4 2.4.9-4.9L2.9 8.1l4.9-.7z" />,
  palette: <><path d="M10 2.8a7.2 7.2 0 1 0 0 14.4c1 0 1.6-.6 1.6-1.4 0-1.2-1.1-1.5-1.1-2.6 0-.9.7-1.5 1.6-1.5h2.3c1.7 0 2.8-1.3 2.8-3 0-3.3-3.3-5.9-7.2-5.9z" />{dot(6.3, 9.6)}{dot(8.4, 6.3)}{dot(12.2, 6.2)}</>,
  pencil: <path d="M13.6 3.4 16.6 6.4 7 16H4v-3zM11.6 5.4l3 3" />,
  trash: <path d="M3.5 5.5h13M8 5.5v-2h4v2M5.5 5.5l.8 11h7.4l.8-11M8.5 8.5v5M11.5 8.5v5" />,
  school: <path d="M2.5 8 10 3.5 17.5 8M4.5 7.2v9.3h11V7.2M8.4 16.5v-4h3.2v4M2.5 16.5h15" />,
  leaf: <path d="M4 16.2C4 9 8 5 16.2 3.8 16.2 12 12 16 6 16.2zM4 16.2l6.2-6.2" />,
  timer: <><circle cx="10" cy="11.2" r="6" /><path d="M8 2.6h4M10 2.6v2.6M10 11.2V8.2M15 5.8l1.2-1.2" /></>,
  checkbox: <><rect x="3" y="3" width="14" height="14" rx="3.5" /><path d="M6.8 10.2 9 12.4l4.3-4.6" /></>,
  columns: <><rect x="3" y="3.5" width="14" height="13" rx="2.5" /><path d="M7.7 3.5v13M12.3 3.5v13" /></>,
  calendar: <><rect x="3" y="4" width="14" height="13" rx="3" /><path d="M3 8h14M7 2.5v3M13 2.5v3M7 11.5h2" /></>,
  progress: <><circle cx="10" cy="10" r="6.5" /><path d="M10 3.5a6.5 6.5 0 0 1 0 13z" fill="currentColor" stroke="none" /></>,
  warning: <><path d="M10 3.2 17.4 16H2.6z" /><path d="M10 8.2v3.4" />{dot(10, 13.9)}</>,
  clipboard: <><rect x="4" y="3.5" width="12" height="14" rx="2" /><path d="M7.5 3.5v-1h5v1M7 8.2h6M7 11.2h6M7 14.2h3.5" /></>,
  chart: <path d="M4 16V9M8.5 16V4M13 16v-5M17 16H3" />,
  sticky: <><path d="M3.5 3.5h13V12l-4.5 4.5h-8.5z" /><path d="M12 16.5V12h4.5" /></>,
  users: <><circle cx="7.5" cy="7" r="2.8" /><path d="M2.5 16.5c.5-3 2.4-4.5 5-4.5s4.5 1.5 5 4.5M12.6 4.3a2.8 2.8 0 0 1 0 5.4M14.6 12.3c1.6.6 2.6 2 2.9 4.2" /></>,
  compass: <><circle cx="10" cy="10" r="7" /><path d="m12.9 7.1-1.7 4.1-4.1 1.7 1.7-4.1z" /></>,
  plus: <path d="M10 4v12M4 10h12" />,
  ring: <circle cx="10" cy="10" r="6.5" />,
  target: <><circle cx="10" cy="10" r="7" /><circle cx="10" cy="10" r="3.6" />{dot(10, 10)}</>,
  done: <><circle cx="10" cy="10" r="7" /><path d="M6.8 10.2 9 12.4l4.3-4.6" /></>,
  blocks: <><rect x="3" y="3" width="6" height="6" rx="1.6" /><rect x="11" y="3" width="6" height="6" rx="1.6" /><rect x="3" y="11" width="6" height="6" rx="1.6" /><rect x="11" y="11" width="6" height="6" rx="1.6" /></>,
} satisfies Record<string, ReactNode>

export type IconName = keyof typeof PATHS

export function Icon({ name, className, label }: { name: IconName; className?: string; label?: string }) {
  return (
    <svg className={`ico${className ? ` ${className}` : ''}`} viewBox="0 0 20 20" role={label ? 'img' : undefined} aria-label={label} aria-hidden={label ? undefined : true}>
      {PATHS[name]}
    </svg>
  )
}
