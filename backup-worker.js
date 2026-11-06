import { DatabaseSync } from 'node:sqlite'
import { workerData } from 'node:worker_threads'

const { file, out } = workerData
const db = new DatabaseSync(file, { readOnly: true })
try {
  db.exec('PRAGMA busy_timeout = 5000; PRAGMA cache_size = -1024; PRAGMA temp_store = FILE')
  db.prepare('VACUUM INTO ?').run(out)
} finally {
  db.close()
}
