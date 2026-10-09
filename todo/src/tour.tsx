import type { TourStep } from './components/Tour'
import { StatusButton } from './components/TaskItem'
import type { Me, View } from './types'

const noop = () => {}
/** A pretend task row for steps about tasks, when you don't have any yet. */
const DemoRow = ({ status, title, note }: { status: 'todo' | 'doing' | 'done'; title: string; note?: string }) => (
  <div className="demo-row"><StatusButton status={status} onCycle={noop} title={title} />{title}{note && <small>{note}</small>}</div>
)
const NO_TASKS = <p className="tour-demo-note">No tasks yet, so here’s an example.</p>

/**
 * The tutorial. Steps with `go` take you to that page first, and `target`
 * is what gets highlighted there (a centred card if it isn't on screen).
 */
export function tourSteps({ me, navigate, showTodo, showLists, openMenu }: { me: Me; navigate: (v: View) => void; showTodo: () => void; showLists: () => void; openMenu: () => void }): TourStep[] {
  const steps: TourStep[] = [
    {
      icon: 'done', title: `Welcome, ${me.name || me.username}!`,
      body: <>Your to-do list, synced across your devices. Here’s a quick look around.</>,
    },
    {
      icon: 'compass', title: 'Your pages', target: '.sidebar .nav', go: () => { navigate({ kind: 'today' }); openMenu() },
      body: <><b>Today</b> shows what’s due (overdue first), <b>Upcoming</b> the next two weeks. The rest are what they say.</>,
    },
    {
      icon: 'plus', title: 'Add a task', target: '[data-quick-add]', go: () => navigate({ kind: 'today' }),
      body: <>Dates, times, priority and lists get picked up as you type:<ul><li><kbd>Maths homework tomorrow 4pm !3 #exam @School</kbd></li><li><kbd>Gym every mon and thu 6pm</kbd></li></ul>Press <kbd>N</kbd> to jump here.</>,
    },
    {
      icon: 'ring', title: 'Tap the circle', target: '.task .status-btn', go: () => navigate({ kind: 'all' }),
      demo: <>{NO_TASKS}<DemoRow status="todo" title="Not started" note="tap" /><DemoRow status="doing" title="In progress" note="tap again" /><DemoRow status="done" title="Completed" /></>,
      body: <>Each tap moves it along: <b style={{ color: 'var(--st-todo)' }}>Not started</b> → <b style={{ color: 'var(--st-doing-ink)' }}>In progress</b> → <b style={{ color: 'var(--st-done)' }}>Completed</b>.</>,
    },
    {
      icon: 'pencil', title: 'Editing', target: '.task', go: () => navigate({ kind: 'all' }),
      demo: <>{NO_TASKS}<DemoRow status="todo" title="Maths homework" note="Tomorrow, 4pm" /></>,
      body: <>Click a task to edit it in place. <b>Reminder → Custom…</b> sets any lead time, like 45 minutes or 3 days. <b>ⓘ</b> opens the full details.</>,
    },
    {
      icon: 'calendar', title: 'Calendar', target: '.cal-grid', go: () => navigate({ kind: 'calendar' }),
      body: <>Drag tasks between days. <b style={{ color: '#d03b3b' }}>Red days</b> are public holidays. Click a date to see its tasks or leave a note.</>,
    },
    {
      icon: 'chart', title: 'Still to do', target: '[data-tour="still-to-do"]', go: () => navigate({ kind: 'stats' }),
      body: <>Your open task count. Click it to see them.</>,
    },
    {
      icon: 'target', title: 'Here they are', target: '.main .tasks', go: showTodo,
      demo: <p className="tour-demo-note">Nothing open right now.</p>,
      body: <>Drag to reorder, or sort by date or priority.</>,
    },
    {
      icon: 'blocks', title: 'Personalize It', target: '.widget-grip', go: () => navigate({ kind: 'board' }),
      body: <>Your own board of blocks. Drag a block by <b>⠿</b> to move it, or a task to another column to change its priority. <b>Edit board</b> to add or remove blocks.</>,
    },
    {
      icon: 'clipboard', title: 'Your lists', target: '.sidebar [data-list-menu]', go: () => { showLists(); openMenu() },
      body: <>Drag to reorder. The <b>⋯</b> (or right-click) edits or deletes a list.</>,
    },
    {
      icon: 'palette', title: 'Make it yours', target: '.side-foot .btn', go: openMenu,
      body: <>Themes, colours, holidays, reminders and notifications are all in <b>Settings</b>.</>,
    },
  ]
  steps.push({
    icon: 'chat', title: 'Part of Whats Up', target: '.side-wa', go: openMenu,
    body: me.whatsapp.configured && me.whatsapp.reminders
      ? <><b>Whats Up</b> takes you back there. Only you can see your tasks.
          <p className="muted">Pick <b>WhatsApp me</b> on a task to get the reminder on WhatsApp {me.whatsapp.botNumber ? <>from the bot’s number. Reply <kbd>done</kbd>, <kbd>snooze 1h</kbd> or <kbd>add buy milk 5pm</kbd>.</> : <>in “Message yourself”. Reply <kbd>td done</kbd> or <kbd>td snooze 1h</kbd>.</>}</p></>
      : <><b>Whats Up</b> takes you back there. Only you can see your tasks.</>,
  })
  steps.push({
    icon: 'done', title: 'That’s it', go: () => navigate({ kind: 'today' }),
    body: <>You can replay this from <b>Settings → Tutorial</b>.</>,
  })
  return steps
}
