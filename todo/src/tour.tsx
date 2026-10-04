import type { TourStep } from './components/Tour'
import { StatusButton } from './components/TaskItem'
import type { Me, View } from './types'

const noop = () => {}
/** A pretend task row for steps about tasks, when you don't have any yet. */
const DemoRow = ({ status, title, note }: { status: 'todo' | 'doing' | 'done'; title: string; note?: string }) => (
  <div className="demo-row"><StatusButton status={status} onCycle={noop} title={title} />{title}{note && <small>{note}</small>}</div>
)
const NO_TASKS = <p className="tour-demo-note">You don’t have any tasks yet, so here’s an example. Add one and it’ll look like this.</p>

/**
 * The tutorial. Steps with `go` take you to that page first, and `target`
 * is what gets highlighted there (a centred card if it isn't on screen).
 */
export function tourSteps({ me, navigate, showTodo, showLists, openMenu }: { me: Me; navigate: (v: View) => void; showTodo: () => void; showLists: () => void; openMenu: () => void }): TourStep[] {
  const steps: TourStep[] = [
    {
      icon: '👋', title: `Welcome, ${me.name || me.username}!`,
      body: <>This is your to-do list, synced to all your devices. A quick tour, about a minute.<p className="muted">Use <b>Next</b> and <b>Back</b> (or the ← → keys). <b>Skip</b> ends it any time.</p></>,
    },
    {
      icon: '🧭', title: 'Your pages', target: '.sidebar .nav', go: () => { navigate({ kind: 'today' }); openMenu() },
      body: <ul><li><b>Today</b>: what’s due now, overdue first.</li><li><b>Upcoming</b>: the next two weeks.</li><li><b>Calendar</b>, <b>All tasks</b>, <b>Completed</b> and <b>Stats</b>.</li></ul>,
    },
    {
      icon: '➕', title: 'Add a task', target: '[data-quick-add]', go: () => navigate({ kind: 'today' }),
      body: <>Type naturally and the chips fill themselves in:<ul><li><kbd>Maths homework tomorrow 4pm !3 #exam @School</kbd></li><li><kbd>Gym every mon and thu 6pm</kbd></li></ul><p className="muted">Shortcut: press <kbd>N</kbd>.</p></>,
    },
    {
      icon: '🔴', title: 'Status: tap the circle', target: '.task .status-btn', go: () => navigate({ kind: 'all' }),
      demo: <>{NO_TASKS}<DemoRow status="todo" title="Not started" note="tap" /><DemoRow status="doing" title="In progress" note="tap again" /><DemoRow status="done" title="Completed" /></>,
      body: <>Each tap moves a task along: <b style={{ color: 'var(--st-todo)' }}>Not started</b> → <b style={{ color: 'var(--st-doing-ink)' }}>In progress</b> → <b style={{ color: 'var(--st-done)' }}>Completed</b>.<p className="muted">Repeating tasks ask before completing, so a slip of the finger doesn’t make the next one.</p></>,
    },
    {
      icon: '✏️', title: 'Edit and set reminders', target: '.task', go: () => navigate({ kind: 'all' }),
      demo: <>{NO_TASKS}<DemoRow status="todo" title="Maths homework" note="Tomorrow, 4pm 🔔" /></>,
      body: <ul><li>Click a task to edit it right there: date, time, repeat, priority, list.</li><li><b>🔔 Reminder → Custom…</b> lets you choose exactly how early, e.g. <b>45 minutes</b> or <b>3 days</b> before.</li><li><b>ⓘ</b> opens all the details.</li></ul>,
    },
    {
      icon: '🗓️', title: 'Calendar', target: '.cal-grid', go: () => navigate({ kind: 'calendar' }),
      body: <ul><li>Drag a task to another day to move it.</li><li><b style={{ color: '#d03b3b' }}>Red days</b> are public holidays (pick your country in Settings).</li><li>Click a date to see its tasks and add your own <b>note</b> next to the date.</li></ul>,
    },
    {
      icon: '📊', title: 'Stats: “Still to do”', target: '[data-tour="still-to-do"]', go: () => navigate({ kind: 'stats' }),
      body: <>How many tasks are still open. <b>Click it</b> and you jump straight to them, like this: press <b>Next</b>.</>,
    },
    {
      icon: '🎯', title: 'Here they are', target: '.main .tasks', go: showTodo,
      demo: <p className="tour-demo-note">Nothing open right now, so the list is empty. Your open tasks will show up here.</p>,
      body: <>All tasks, filtered to <b>To do</b>. Drag them into your own order, or sort by date or priority.</>,
    },
    {
      icon: '✨', title: 'Personalize It', target: '.widget-grip', go: () => navigate({ kind: 'board' }),
      body: <>Your own page of blocks: a <b>priority board</b>, a <b>to-do list</b>, today, stats, notes…<ul><li>Drag a block by <b>⠿</b> to move it.</li><li>Drag a task to another column to change its priority.</li><li><b>✎ Edit board</b> adds, resizes and removes blocks.</li></ul></>,
    },
    {
      icon: '📋', title: 'Your lists', target: '.sidebar [data-list-menu]', go: () => { showLists(); openMenu() },
      body: <>Drag lists to reorder them. <b>Lists ›</b> rolls the section up or down, and <b>View more</b> shows the rest when you have more than 4. The <b>⋯</b> on a list (or a right-click) lets you <b>edit or delete</b> it. When deleting, you choose whether its tasks go too.</>,
    },
    {
      icon: '🎨', title: 'Make it yours', target: '.side-foot .btn', go: openMenu,
      body: <>In <b>Settings</b>: the Discord, Mono or Classic look, your own colours (sidebar, buttons, task cards…), holidays, the default early reminder and notifications.<p className="muted">This tutorial is in Settings too, if you want it again.</p></>,
    },
  ]
  steps.push({
    icon: '💬', title: 'Part of Whats Up', target: '.side-wa', go: openMenu,
    body: me.whatsapp.configured && me.whatsapp.reminders
      ? <>Your todolist lives inside Whats Up: <b>{me.home.startsWith('/u/') ? 'Back to chats' : 'Back to admin'}</b> takes you back, and the ✓ button in Whats Up brings you here. Only you can see your tasks.
          <p className="muted">🤖 <b>WhatsApp Buddy</b>: pick <b>💬 WhatsApp me</b> on a task and Buddy messages you {me.whatsapp.botNumber ? <>on your WhatsApp from its own number. Reply <kbd>done</kbd>, <kbd>snooze 1h</kbd> or <kbd>add buy milk 5pm</kbd> right there.</> : <>in “Message yourself”. Reply <kbd>td done</kbd> or <kbd>td snooze 1h</kbd>.</>} Settings → WhatsApp Buddy.</p></>
      : <>Your todolist lives inside Whats Up: <b>{me.home.startsWith('/u/') ? 'Back to chats' : 'Back to admin'}</b> takes you back, and the ✓ button in Whats Up brings you here.</>,
  })
  steps.push({
    icon: '🎉', title: 'You’re all set!', go: () => navigate({ kind: 'today' }),
    body: <>Replay this any time from <b>Settings → Tutorial</b>. Have a productive day 💪</>,
  })
  return steps
}
