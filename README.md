# wa-hub — many WhatsApp accounts, one server, one URL each

Every path is one person's own WhatsApp, permanently:

```
https://your-app.up.railway.app/          ← portal, lists the sessions
https://your-app.up.railway.app/1/        ← Ali's WhatsApp   (browser profile 1)
https://your-app.up.railway.app/2/        ← Budi's WhatsApp  (browser profile 2)
https://your-app.up.railway.app/3/        ← Citra's WhatsApp (browser profile 3)
```

Each one is a full, separate Firefox profile running WhatsApp Web on the server.
Ali scans his QR code once at `/1/` and stays logged in. Budi does the same at `/2/`.
They can't see each other. Closing `/1/` doesn't touch `/2/`. Redeploying doesn't
log anybody out, because all three profiles live on a persistent volume at `/data`.

Inside the container:

```
Caddy :$PORT                       ← the single port Railway exposes
 ├── /healthz                      ← Railway health check
 ├── /          → portal page      ← password protected
 ├── /1/*  →  websockify :6081 → x11vnc :5901 → Xvfb :101 → Firefox → /data/profile-1
 ├── /2/*  →  websockify :6082 → x11vnc :5902 → Xvfb :102 → Firefox → /data/profile-2
 └── /3/*  →  websockify :6083 → x11vnc :5903 → Xvfb :103 → Firefox → /data/profile-3
```

---

## Step 1 — Put this on GitHub

```bash
cd wa-hub
git init && git add -A && git commit -m "wa-hub"
gh repo create wa-hub --private --source=. --push
```

(Or create an empty repo on github.com and `git push` to it. Private is fine —
Railway can build private repos once you link your GitHub account.)

## Step 2 — Deploy

Pick one. **A** is faster the first time; **B** is reproducible and sets up the
volume for you, which is the step people forget.

### A. Dashboard (about 3 minutes, no CLI)

1. [railway.com/new](https://railway.com/new) → **Deploy from GitHub repo** → pick `wa-hub`.
   Railway detects the Dockerfile and starts building.
2. Service → **Variables** → add:
   ```
   SESSIONS = 3
   NAMES    = Ali,Budi,Citra
   PASSWORD = <pick something long>
   ```
   Don't add `PORT` — Railway injects it.
3. Service → **Data → Add Volume** → mount path **`/data`**.
   **Do this before anyone scans a QR code.** Without it, the first redeploy
   wipes every login.
4. Service → **Settings → Networking → Generate Domain**.
5. Wait for the build (5–8 minutes the first time — it's installing Firefox).

### B. CLI with Infrastructure as Code

This declares the service *and* the `/data` volume in `.railway/railway.ts`, so the
volume can't be forgotten and the whole setup is reproducible.

```bash
npm install                     # installs the `railway` IaC SDK
railway login
railway init                    # creates the project, links this directory

export WA_HUB_REPO="your-github-username/wa-hub"
export WA_HUB_SESSIONS=3
export WA_HUB_NAMES="Ali,Budi,Citra"

railway config plan             # shows exactly what it will create
railway config apply            # creates the service + volume after you confirm

railway variables --set "PASSWORD=<pick something long>"
railway domain                  # generates the public URL
```

`railway config plan` is read-only, so run it as often as you like. Note that
Railway retired `railway.json` / `railway.toml` — those files stop being read on
2026-12-01, which is why this repo uses `.railway/railway.ts` instead.

## Step 3 — Use it

Open `https://your-app.up.railway.app/` and log in.

- Username: `wa`, password: whatever you set as `PASSWORD`.
- If you never set `PASSWORD`, one is generated on first boot, printed in the
  deploy logs, and saved to the volume so it stays the same. Search the logs for
  `password:`.

Click a session. You'll see Firefox with the WhatsApp Web QR code. On the phone
that belongs to that session: **WhatsApp → Settings → Linked devices → Link a
device → scan**. Done — that URL is now that person's WhatsApp, and it stays
logged in.

---

## Variables

| Variable | Default | What it does |
| --- | --- | --- |
| `SESSIONS` | `3` | How many independent WhatsApps. Each costs roughly 1 GB RAM. |
| `PASSWORD` | generated | Opens the portal and every session. |
| `NAMES` | — | `Ali,Budi,Citra` — labels shown on the portal page. |
| `USER_n` / `PASS_n` | — | Per-session credentials. Set these when each person should only be able to open their own session. |
| `USERNAME` | `wa` | Default login name when `USER_n` isn't set. |
| `BRAND` | `WhatsApp Hub` | Portal page heading. |
| `SCREEN` | `1440x900x24` | Virtual screen size. Smaller = less RAM and bandwidth. |
| `KIOSK` | `1` | `0` gives Firefox its normal tabs and URL bar. |
| `START_URL` | `https://web.whatsapp.com` | |

**On isolation:** by default one password opens everything, which is right when
it's you managing several accounts. If three different people are using it, give
each their own:

```
USER_1=ali    PASS_1=...
USER_2=budi   PASS_2=...
USER_3=citra  PASS_3=...
```

Then Ali's credentials open `/1/` and nothing else.

## Adding a person later

Change `SESSIONS` from `3` to `4` and redeploy. `/4/` appears with a fresh profile
and an empty QR code. Sessions 1–3 keep their logins — their profile directories
are never touched.

## Making a real one-click button

The `[Deploy on Railway]` buttons you see around the web point at a template, and
a template has to be published from a Railway account — so you mint your own once
this is running:

1. Deploy it once (step 2).
2. Project → **⋮ → Create Template from Project**, keep it unlisted.
3. Railway gives you a URL like `https://railway.com/new/template/abc123`.
4. Drop this in your README:

```markdown
[![Deploy on Railway](https://railway.com/button.svg)](https://railway.com/new/template/abc123)
```

Now spinning up a second, separate hub is genuinely one click, volume included.

---

## Gotchas worth knowing before you scale it

**Budget ~1 GB RAM per session.** Firefox with WhatsApp Web loaded is heavy, and
these browsers stay running 24/7 on purpose — that's what keeps everyone logged
in. Three sessions is comfortable. Start at `SESSIONS=1`, watch the memory graph,
then raise it.

**This is not a scale-to-zero workload.** Railway bills on usage and the container
never idles. Check the cost after a day before you add session number ten.

**`/dev/shm` is 64 MB** in most container runtimes and Railway won't let you change
it. Firefox usually copes. If you see content-process crashes, lower `SCREEN`
first — `1280x720x24` helps a lot.

**Linked devices expire.** WhatsApp unlinks a device if the phone hasn't been
online for about 14 days, and each account allows a limited number of linked
devices. The volume can't help with that; the phone has to check in.

**The password is the entire security boundary.** Anyone with a URL and password
has full read/write access to that WhatsApp — messages, contacts, everything. Use
long unique passwords, and for anything beyond a hobby put Cloudflare Access or a
Tailscale tailnet in front rather than leaving it on the open internet.

**Normal use only.** Remote-controlling your own linked devices is ordinary WhatsApp
Web usage. Driving these sessions for bulk or automated messaging will get the
numbers banned, which is a WhatsApp policy thing, not a limitation of this setup.

**Don't hand one path to two people.** Both viewers share the same screen (x11vnc
runs `-shared`) and will fight over the mouse. It's deliberate — it lets you watch
your own session from phone and laptop at once.

## Local test

```bash
docker build -t wa-hub .
docker run --rm -p 8080:8080 -v "$PWD/data:/data" \
  -e SESSIONS=2 -e NAMES="Test A,Test B" -e PASSWORD=secret123 \
  --shm-size=1g wa-hub
# → http://localhost:8080/
```

## Troubleshooting

| Symptom | Cause |
| --- | --- |
| Grey screen, "Failed to connect" | Firefox is still booting. Wait ~30s and refresh; the page auto-reconnects. |
| Everyone logged out after a deploy | The `/data` volume isn't mounted. Check Service → Data. |
| Health check fails during deploy | First build is slow to start. `healthcheckTimeout` is already set to 300s in `.railway/railway.ts`. |
| Firefox restarting in a loop | Out of memory. Lower `SESSIONS` or `SCREEN`. |
| Password changed by itself | You never set `PASSWORD` and the volume was recreated. Set it explicitly. |
| Browser asks for the password again on each session | Expected with per-session `USER_n`/`PASS_n` — different credentials, different prompt. |
