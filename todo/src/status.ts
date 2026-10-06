import type { Task } from './types'

export type Status = 'todo' | 'doing' | 'done'
export const STATUSES: Status[] = ['todo', 'doing', 'done']
export const STATUS_LABEL: Record<Status, string> = { todo: 'Not started', doing: 'In progress', done: 'Completed' }
export const nextStatus = (s: Status): Status => (s === 'todo' ? 'doing' : s === 'doing' ? 'done' : 'todo')
export const statusOf = (t: Pick<Task, 'done'> & { status?: Status }): Status => t.status || (t.done ? 'done' : 'todo')
