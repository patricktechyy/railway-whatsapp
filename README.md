# Whats Up

Whats Up serves separate WhatsApp accounts and Gavin’s Todolist from one Node.js process. The Dockerfile builds the Todolist and runs both apps together on Node 22 Alpine with ffmpeg.

## Run locally

Use Node.js **22.13 or newer** for built-in SQLite. Run `npm install`, `npm run build:todo` and then `npm start`. Set `ADMIN_PASSWORD` and point `DATA_DIR` at a local directory. Run `npm test` for the automated suite. The tests use simulated WhatsApp connections.

## Data on the volume

```text
/data/
  users.json, passwords.json, scheduled.json
  accounts/<username>-<id>/
    auth/            WhatsApp link credentials
    messages.db      message history and group metadata (SQLite)
    chat-meta.json   chats, contacts, aliases, deleted IDs, and chat locks
  todo/
    users/<username>.json
    ...              Todolist settings, reminders, and other data
```

The app uses SQLite’s write-ahead log (WAL) on the same volume and commits pending writes every five to six seconds and at graceful shutdown. Uploads, downloads, and conversions use the system temporary directory. Admin backups include consistent copies of the SQLite databases and omit live WAL and SHM files.

| Variable | Default | Purpose |
| --- | --- | --- |
| `DATA_DIR` | `/data` | Persistent data directory |
| `PORT` | `8080` | HTTP port |
| `ADMIN_PASSWORD` | Generated on first start | Main admin password |
| `HISTORY_DAYS` | `14` | Retained messages, with a minimum of 7 days |
| `FULL_HISTORY` | Off | Set to `1` to request full history on pairing |
| `MAX_UPLOAD_MB` | `25` | Existing upload size limit in MiB |
| `MEDIA_IDLE_MS` | `30000` | Time without bytes before a download attempt fails |
| `MEDIA_DOWNLOAD_ATTEMPTS` | `3` | Download attempts |
| `FFMPEG`, `FFPROBE` | `ffmpeg`, `ffprobe` | Paths to media conversion and inspection tools |
| `MEM_LOG_MS` | `60000` | Memory log interval in milliseconds. Set to `0` to turn it off |

## First Railway rollout

1. Download a backup from the main admin page on the current service. Open the archive and verify it contains the account directories, their legacy `store.json` files, and the Todolist data. Keep this backup somewhere private and off the Railway volume.
2. Check available volume space before starting. Each account temporarily needs both its JSON and SQLite copies, and SQLite can use more storage than the original JSON. In the synthetic benchmark, an 18 MiB legacy store became a 32 MiB SQLite store including metadata. The needed headroom depends on real account sizes.
3. Build the Docker image and test it on a separate staging volume with a spare WhatsApp number before deploying to production. Check pairing and recent history, text and media in both directions, notes on an iPhone/Safari, forwarding, polls, group ticks, quoted replies, chat lock, scheduled sends, push notifications, and Buddy. Restart the app, confirm the account reconnects and stored messages still load, and test restoring an admin backup.
4. On the first start, `/healthz` answers while accounts migrate and normal app requests wait. Confirm each account logs a successful migration and comes online. Look for any `[boot]` failures or WAL warnings. After verification, the app removes each migrated account’s legacy `store.json`.
5. Compare Railway’s memory graph and the `[mem]` log over idle hours, busy periods, and reconnects. `rss` is resident process memory. `heap` shows used and allocated V8 heap. `external` includes memory outside the JS heap, with `buffers` breaking out array buffers. Compare these with the connected account and viewer counts. The platform graph can also reflect memory outside the Node process, including ffmpeg.

### Restore or roll back

Stop the service before restoring. Extract the archive, then restore the **contents** of its top-level `data/` into an empty volume or empty data directory. Start the matching app version and verify the accounts, message counts, and Todolist data. For rollback to the pre-SQLite build, use the backup taken **before** migration and start the pre-SQLite code. Messages and other changes since that backup will be absent from the restored state.

## Local verification

On Windows with Node 22, a workload of 12 simulated accounts, 720,000 messages and 540 chat API requests per run produced the following process memory readings.

| Build | Idle RSS | Peak RSS |
| --- | ---: | ---: |
| Original | 489 MiB | 563 MiB |
| SQLite, normal restart | 103 MiB | 107 MiB |
| SQLite, first migration | 95 MiB | 197 MiB |

The local HTTP smoke test migrated a synthetic account, restored its admin backup into a fresh data directory and served all 1,000 messages. It also converted WebM uploads into Ogg/Opus voice notes and 480×480 H.264/AAC video notes with ffmpeg.

To reproduce the comparison, copy the scripts from `tools/bench/` to a scratch directory. Place copies of the previous deployment’s source and the updated source in `old/` and `new/` inside that directory and install their runtime dependencies. From the scratch directory, run `node gen.mjs data-old 12 60000`, copy the generated data to `data-new`, then run `node bench.mjs old data-old 18101 12` and `node bench.mjs new data-new 18102 12`. Repeat the new run against the same data to measure a normal restart. Live WhatsApp connections and Railway container memory need separate measurement before evaluating the 100–200 MiB peak target.
