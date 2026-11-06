import { parentPort, workerData } from 'node:worker_threads'
import { migrateLegacy } from './store.js'

// Moves one account's old store.json into its message database. It runs in a worker thread, so the big
// file is read into memory that is given back when this ends, and the server keeps answering meanwhile.
try {
  parentPort.postMessage({ ok: true, moved: migrateLegacy(workerData.file) })
} catch (e) {
  parentPort.postMessage({ ok: false, error: e.message })
}
