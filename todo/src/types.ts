import type { Repeat } from './repeat'
export type { Repeat }

export type Priority = 0 | 1 | 2 | 3 // none, low, medium, high

export type ListColor = 'blue' | 'orange' | 'aqua' | 'yellow' | 'magenta' | 'green' | 'violet'
export const LIST_COLORS: ListColor[] = ['blue', 'orange', 'aqua', 'yellow', 'magenta', 'green', 'violet']

export interface Subtask {
  id: string
  title: string
  done: boolean
}

export interface Task {
  id: string
  title: string
  notes: string
  listId: string | null
  done: boolean
  status: 'todo' | 'doing' | 'done' // not started / in progress / completed
  doneAt: number | null
  due: string | null // YYYY-MM-DD
  time: string | null // HH:MM
  remind: number | null // minutes before due
  repeat: Repeat | null
  spawnedId?: string // a finished repeat: the copy it created for the next date
  from?: TaskFrom // given to you by the admin (only the server sets this)
  wa?: WaRemind | null // "💬 WhatsApp me": WhatsApp Buddy messages you about it
  chat?: { jid: string; name: string } | null // made from a WhatsApp message in this chat
  priority: Priority
  tags: string[]
  subtasks: Subtask[]
  links: TaskLink[]
  order: number
  createdAt: number
  updatedAt: number
}

/** An exact moment (ms) or minutes before the due time; `sent` is set by the server once it went out. */
export interface WaRemind { at?: number; before?: number; sent?: string }
export type BuddyStyle = 'friendly' | 'short' // shown as Long / Short
export interface BuddySettings { on: boolean; style: BuddyStyle; morning: string | null; evening: string | null }

export interface TaskFrom { by: string; name: string; assignment: string }

export interface TaskLink {
  url: string
  title: string
}

export interface List {
  id: string
  name: string
  emoji: string
  color: ListColor | string // a palette colour, or your own #rrggbb
  order: number
  createdAt: number
}

export interface DayNote {
  label: string
  notes: string
  color: ListColor
  updatedAt?: number
}

export interface Data {
  rev: number
  profile: { name: string }
  lists: List[]
  tasks: Task[]
  dayNotes?: Record<string, DayNote>
  board?: Board
}

export type WidgetType = 'priority' | 'todo' | 'today' | 'upcoming' | 'doing' | 'overdue' | 'list' | 'status' | 'stats' | 'notes'
export type StickyColor = 'yellow' | 'pink' | 'green' | 'blue' | 'purple'
export interface Widget {
  id: string
  type: WidgetType
  title: string
  size: 'sm' | 'md' | 'lg' // rough width (kept for older versions)
  w?: number // width in columns of a 12-column grid (3–12)
  h?: number | null // your own height in px; null = fit the content
  hidden?: boolean // unticked in "Blocks"
  config: { text?: string; listId?: string | null; color?: StickyColor }
}
export interface Board { widgets: Widget[] }

export type Preset = 'discord' | 'mono' | 'classic' | 'custom'
export interface Appearance {
  preset: Preset
  sidebar: string | null
  accent: string | null
  button: string | null
  taskBg: string | null
  /** Your saved Custom look (kept while another style is chosen). */
  custom?: CustomLook | null
  /** The Personalize It gradient (null = the style's own). */
  personalize?: Gradient | null
}
export interface Gradient { from: string; to: string; angle: number }
export type BasePreset = 'discord' | 'mono' | 'classic'
export type CustomKey = 'sidebar' | 'accent' | 'button' | 'taskBg' | 'page' | 'card' | 'text'
export type CustomLook = { base: BasePreset } & Record<CustomKey, string | null>

export interface Me {
  username: string
  name: string
  admin: boolean
  brand: string
  version: string
  waReminders: boolean
  holidayCountry: string
  holidayCountries: { code: string; name: string }[]
  appearance: Appearance | null
  tourDone: boolean
  /** Where "back to WhatsApp" goes: your chats (/u/you/), or /admin for the admin login. */
  home: string
  whatsapp: {
    /** You have a Whats Up account with a WhatsApp (the ADMIN_PASSWORD login has none). */
    configured: boolean
    reminders: boolean; share: boolean; inbox: boolean; jump: boolean; buddy: boolean
    /** Buddy writes from the bot's own number (reply in that chat, no "td"). */
    botNumber: boolean
    bot: { name: string; phone: string; connected: boolean } | null
    /** Your WhatsApp is linked to Whats Up, and its number. */
    linked: boolean
    phone: string
  }
  buddy: BuddySettings
}

export type View =
  | { kind: 'today' }
  | { kind: 'upcoming' }
  | { kind: 'all' }
  | { kind: 'completed' }
  | { kind: 'calendar' }
  | { kind: 'stats' }
  | { kind: 'list'; id: string }
  | { kind: 'inbox' }
  | { kind: 'tag'; tag: string }
  | { kind: 'admin' }
  | { kind: 'board' }
  | { kind: 'group'; id: string }
  | { kind: 'exams' }
  | { kind: 'study' }

/** Someone with a Whats Up account. */
export interface Person { username: string; name: string }
/** A task in a group: like your own, plus who it's for and who did it. */
export interface GroupTask extends Task { assignee: string | null; by: string; doneBy: string | null }
/** A few people sharing one task list. */
export interface Group { id: string; name: string; emoji: string; owner: string; members: Person[]; tasks: GroupTask[]; rev: number; createdAt: number }

// ------------------------------------------------------------------ exams
export type ColorName = 'blue' | 'orange' | 'aqua' | 'yellow' | 'magenta' | 'green' | 'violet' | 'none'
export interface School { id: string; name: string; color: ColorName; people?: number }
/** One paper on a school's exam timetable. */
export interface Exam {
  id: string; school: string; subject: string; paper: string; date: string
  start: string | null; minutes: number | null; who: string; venue: string; notes: string; at: number
}
export interface ExamRequest extends Omit<Exam, 'id' | 'at'> {
  id: string; by: string; byName?: string; status: 'pending' | 'added' | 'declined'; reason: string; at: number; examId: string | null
}
export interface ExamsData {
  schools: School[]
  school: string | null // yours
  subjects: string[] // the ones you take (empty: all of them)
  showing: string | null // the school these exams are for ('all' for admins looking at everything)
  exams: Exam[]
  requests: ExamRequest[]
  admin: boolean
}

// ---------------------------------------------------------- study planner
export type StudyMode = '' | 'RE' | 'P' | 'RE+P'
export interface StudySubject { id: string; name: string; color: ColorName; priority: boolean }
export interface StudyTopic { id: string; text: string; done: boolean }
/** One subject to study on one day: how (revise / practice) and which topics. */
export interface StudyBlock { id: string; date: string; subject: string; mode: StudyMode; topics: StudyTopic[]; note: string; done: boolean; order: number }
/** A test happening that day that isn't on the Exams page (class tests, AFRs…). */
export interface StudyTest { id: string; date: string; title: string; note: string }
export interface StudyPlan {
  rev: number
  subjects: StudySubject[]
  days: Record<string, 'rest' | 'late'>
  tests: StudyTest[]
  blocks: StudyBlock[]
}

export type TaskInput = Partial<Omit<Task, 'id' | 'order' | 'createdAt' | 'updatedAt' | 'doneAt'>>
