# wa-lite — several WhatsApp accounts, one URL each

```
https://your-app.up.railway.app/      ← portal, lists the sessions
https://your-app.up.railway.app/1/    ← Ali's WhatsApp
https://your-app.up.railway.app/2/    ← Budi's WhatsApp
https://your-app.up.railway.app/3/    ← Citra's WhatsApp
```

Each URL is one person's own WhatsApp. Scan the QR code once from that phone and
it stays linked. Chat list, message history, send, receive, photos, voice notes,
documents. They can't see each other's chats. Restarting or redeploying doesn't
log anyone out.

**No browser on the server.** This speaks WhatsApp's multi-device protocol
directly over a WebSocket, so there's no Firefox, no X server, no VNC, no video
stream to your screen — just JSON over HTTP. One Node process handles every
session.

| | browser-based approach | wa-lite |
| --- | --- | --- |
| RAM | ~1 GB per session | ~25 MB per session, ~60 MB base |
| Image size | ~1.5 GB | ~250 MB |
| Bandwidth | continuous video stream | a few KB per message |
| Works on mobile data | painfully | fine |

---

## Read this before you deploy

wa-lite talks to WhatsApp through **Baileys**, an open-source community
implementation of the multi-device protocol. It is not built or sanctioned by
Meta. In practice it works well and a lot of people run it, but you should know:

- **Linked numbers carry some ban risk.** Meta detects unofficial clients. Normal
  human-paced use of a few accounts is usually fine; anything that looks like
  bulk or automated messaging is what gets numbers banned.
- **Don't put business-critical numbers on it** without accepting that risk. The
  sanctioned route for that is Meta's WhatsApp Business Platform (Cloud API),
  which is a different product with a different shape — templates, approved
  message types, per-message pricing.
- **The browser-based version has no such risk**, because it is literally
  WhatsApp Web. That's the trade you're making for the 40× drop in memory.

For a hobby project running your own or your team's accounts, this is a
reasonable trade. Just make it knowingly.

---

## Step 1 — Put this on GitHub

```bash
cd wa-lite
git init && git add -A && git commit -m "wa-lite"
gh repo create wa-lite --private --source=. --push
```

## Step 2 — Deploy

### A. Dashboard (about 2 minutes, no CLI)

1. [railway.com/new](https://railway.com/new) → **Deploy from GitHub repo** → pick `wa-lite`.
2. Service → **Variables**:
   ```
   SESSIONS = 3
   NAMES    = Ali,Budi,Citra
   PASSWORD = <pick something long>
   ```
   Leave `PORT` alone — Railway injects it.
3. Service → **Data → Add Volume** → mount path **`/data`**.
   Do this before anyone scans a QR code.
4. Service → **Settings → Networking → Generate Domain**.

Build takes about a minute — it's just `npm install` on a slim Alpine image.

### B. CLI, with the volume declared in code

```bash
npm install
railway login
railway init

export WA_REPO="your-github-username/wa-lite"
export WA_SESSIONS=3
export WA_NAMES="Ali,Budi,Citra"

railway config plan      # read-only preview
railway config apply     # creates service + volume after you confirm

railway variables --set "PASSWORD=<pick something long>"
railway domain
```

This path creates the `/data` volume for you, which is the step people forget.
Note that Railway retired `railway.json`/`railway.toml` — they stop being read on
2026-12-01 — so this repo uses `.railway/railway.ts` instead.

## Step 3 — Use it

Open the domain. Username `wa`, password whatever you set. If you never set
`PASSWORD`, one is generated on first boot, printed in the deploy logs, and saved
to the volume so it stays the same — search the logs for `password:`.

Click a session, and a QR code appears. On the phone for that account:
**WhatsApp → Settings → Linked devices → Link a device → scan.**

That's it. The chat list loads, messages stream in live, and you can reply.

---

## Variables

| Variable | Default | Purpose |
| --- | --- | --- |
| `SESSIONS` | `3` | How many independent accounts. |
| `PASSWORD` | generated | Opens the portal and every session. |
| `NAMES` | — | `Ali,Budi,Citra` — labels on the portal and chat header. |
| `USER_n` / `PASS_n` | — | Per-session credentials, for real isolation. |
| `USERNAME` | `wa` | Default login name when `USER_n` isn't set. |
| `BRAND` | `WhatsApp Hub` | Portal heading. |
| `DATA_DIR` | `/data` | Must match the volume mount path. |

**Isolation.** By default one password opens everything — right when it's you
running several accounts. When three different people use it, give each their own:

```
USER_1=ali    PASS_1=...
USER_2=budi   PASS_2=...
USER_3=citra  PASS_3=...
```

Then Ali's credentials open `/1/` and return 401 everywhere else. This is tested.

## Adding a person later

Raise `SESSIONS` and redeploy. The new path appears with a fresh QR code; existing
sessions keep their logins, because their credentials sit in
`/data/session-N/auth/` and are never touched.

## Making a real one-click button

Railway's `[Deploy on Railway]` buttons point at a template, and templates are
published from an account — so you mint your own once this runs:

1. Deploy it (step 2).
2. Project → **⋮ → Create Template from Project** (unlisted is fine).
3. You get a URL like `https://railway.com/new/template/abc123`.
4. Put this in your README:

```markdown
[![Deploy on Railway](https://railway.com/button.svg)](https://railway.com/new/template/abc123)
```

Now a second hub really is one click, volume and variables included.

---

## What it does and doesn't do

Works: QR login, chat list sorted by recency with unread badges, search,
message history, sending text, receiving live, photos and stickers inline,
video/audio/documents as download links, group chats with sender names, read
receipts, auto-reconnect with backoff.

Not built: sending media, voice notes, replies/quotes, reactions, starting a new
chat with an unknown number, profile pictures, typing indicators, status/stories.
All reachable through Baileys if you want them — `src/session.js` is where to add
them, and it's about 250 lines.

History depth: WhatsApp only hands a linked device a limited backlog on first
sync, so old conversations will look sparse at the start and fill in as messages
arrive. wa-lite keeps the most recent 120 messages per chat and 400 chats in a
JSON snapshot on the volume.

## Gotchas

**Linked devices expire.** WhatsApp unlinks a device if the phone hasn't been
online for about 14 days, and each account allows a limited number of linked
devices. The session will show the QR screen again — just re-scan.

**The password is the entire security boundary.** Anyone with a URL and password
can read and send as that account. Use long unique passwords. For anything beyond
a hobby, put Cloudflare Access or a Tailscale tailnet in front.

**`markOnlineOnConnect` is off on purpose.** If it were on, WhatsApp would treat
the session as the active device and stop pushing notifications to the person's
phone. Leaving it off means they keep getting notified normally.

**Don't run two copies against the same volume.** Two processes sharing one set
of credentials will fight over the Signal session keys and break message
delivery. Keep the service at one replica.

## Local test

```bash
npm install
PASSWORD=test123 SESSIONS=2 NAMES="A,B" DATA_DIR=./data npm start
# → http://localhost:8080/
```

## Troubleshooting

| Symptom | Cause |
| --- | --- |
| QR screen reappears after a while | Phone offline too long, or the device was unlinked from the phone. Re-scan. |
| Everyone logged out after a deploy | The `/data` volume isn't mounted. Check Service → Data. |
| Chat list is empty right after linking | Initial sync is still arriving. Wait 30–60 seconds. |
| Very little old history | Expected — WhatsApp only sends a linked device a limited backlog. |
| `Cannot find module 'baileys'` at build | Some forks publish as `@whiskeysockets/baileys`. Swap the dependency name in `package.json`; `src/session.js` already falls back to that name at import time. |
| Sends fail with "not connected" | Session is reconnecting. The status dot in the header turns green when it's ready. |
