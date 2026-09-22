# wa-lite — several WhatsApp accounts, each with its own login

```
https://your-app.up.railway.app/              ← everyone signs in here
https://your-app.up.railway.app/u/ali/        ← Ali's WhatsApp (only Ali's password opens it)
https://your-app.up.railway.app/u/budi/       ← Budi's WhatsApp
https://your-app.up.railway.app/admin         ← you: add / remove people
```

One Node process, no browser on the server. Each person has their own
username and a password **they** choose; you only decide who exists.

---

## Upgrading from the previous version — read this

**1. Push and deploy.** Nothing to delete. On first boot the new version finds
your old `/data/session-1`, `/data/session-2`… folders and turns them into users
(named from your old `NAMES` variable, e.g. `ali`, `budi`). Their phones stay
linked. Your old `PASSWORD` variable keeps working as the **admin** password.

**2. Give everyone a password.** Sign in at `/` with username `admin` and that
password. Next to each person press **Setup link**, copy it, send it to them.
They open it, pick a password, and they're in.

**3. Re-link once to get history.** WhatsApp only hands over chat history at the
moment a device is linked, and the old version was linked with settings that
got none. Each person opens **⋮ → Re-link WhatsApp** and scans the new QR code.
Their chats, contacts and recent history then stream in over a minute or two.

After that you can delete the old `SESSIONS`, `NAMES`, `USER_n` and `PASS_n`
variables. Optionally rename `PASSWORD` to `ADMIN_PASSWORD`.

---

## What changed and why

**History and names.** The previous build used Baileys 6. WhatsApp has been
moving everyone to "LIDs" — anonymous IDs like the `244130370322560` in your
screenshot — and version 6 can't translate those back to a phone number or
contact name. This build uses Baileys 7, advertises the canonical WhatsApp Web browser identity
for pairing, requests the full backlog, and explicitly accepts every history type. Every time WhatsApp reveals that a LID belongs to a phone number, the two
chats are merged so a person never shows up twice.

**Starting a chat.** Press ✎. Search your contacts by name or number, or type a
full number with country code (`6591234567`) — it's checked against WhatsApp
first, so typos get a clear "not on WhatsApp" instead of a silent failure.

**Sending photos and files.** 📎, paste an image, or drag a file onto the chat.
Photos are converted to JPEG and a small preview is made in *your* browser, so
the server still needs no image library. Anything that isn't a JPEG/PNG/WebP
photo (PDFs, videos, GIFs, iPhone HEIC in some browsers) goes as a file. Max
25 MB.

**Older messages.** Open a chat and press **Load earlier messages** at the top.
That asks the person's phone for 50 more; the phone has to be online.

**Accounts.** Passwords are hashed with scrypt, never stored. Changing a
password signs out every other device. Resetting one (admin) signs the person
out everywhere and makes them pick a new one. Ten wrong logins from one address
locks that address out for 15 minutes.

---

## Fresh deploy

1. Push this folder to GitHub.
2. [railway.com/new](https://railway.com/new) → **Deploy from GitHub repo**.
3. **Variables:** `ADMIN_PASSWORD = <something long>`
4. **Data → Add Volume** → mount path `/data`. Before anyone links a phone.
5. **Settings → Networking → Generate Domain.**
6. Open the domain, sign in as `admin`, add people, send them their links.

Or with the CLI (creates the volume for you):

```bash
npm install
railway login && railway init
export WA_REPO="your-github-username/railway-whatsapp"
railway config apply --file railway.ts
railway variables --set "ADMIN_PASSWORD=<something long>"
railway domain
```

If you never set `ADMIN_PASSWORD`, one is generated on first boot and printed
in the deploy logs (search for `admin password:`), and saved to the volume.

## Managing people

| You want to… | Do this in `/admin` |
| --- | --- |
| Add someone | Type a username and name → **Add** → copy the link → send it to them. |
| Someone forgot their password | **Reset password** → send the new link. Their WhatsApp stays linked. |
| Someone lost/changed their phone | **Unlink phone**. They scan a new QR next time they sign in. |
| Remove someone | **Remove** → type their username to confirm. Unlinks their phone and deletes their data here. |

Usernames and display names are fixed once created. If you got one wrong,
remove and re-add the person — ideally before they link their phone.

Setup links work once and expire after 7 days. You can't read anyone's chats
from the admin page. (You *could* reset someone's password and use the link
yourself — they'd notice, because it signs them out.)

## Variables

| Variable | Default | |
| --- | --- | --- |
| `ADMIN_PASSWORD` | generated | Admin login. The old `PASSWORD` still works. |
| `BRAND` | `Apa yang Diatas (Whats Up)` | Name on the login page. |
| `FULL_HISTORY` | `1` | `0` takes only recent history at pairing (lighter on very large accounts). |
| `HISTORY_DAYS` | `12` | Messages older than this are not saved, and are removed from storage. |
| `MAX_MSGS_PER_CHAT` | `150` | Messages kept per chat on the server. |
| `MAX_CHATS` | `800` | Chats kept. |
| `MAX_UPLOAD_MB` | `25` | Largest file you can send. |
| `DATA_DIR` | `/data` | Must match the volume mount. |
| `WA_LOG` | `info` while linking, `warn` after | Baileys' own logging. `debug` for more detail, `silent` for none. |
| `WA_VERSION` | auto | Force a WhatsApp Web version, e.g. `2.3000.1047506285`. Only if the logs show 405s that don't clear on their own. |

## Many people, many devices

Each person signs in on as many devices as they like — phone, laptop, tablet —
and each stays signed in for 30 days. Everything is live on all of them: send
from the laptop and it appears on the phone; open a chat on one and the unread
badge clears on the others.

**Linking from a phone.** You can't scan a QR code that's on your own screen.
Anyone opening their page on the same phone that has WhatsApp gets a
**link with a code instead** option: they type their number, get an 8-character
code, and enter it in WhatsApp under *Linked devices → Link a device → Link with
phone number instead*. If that ever fails with "couldn't link", open the page
on any other screen and scan the QR there — it only has to happen once.

**People who haven't set up yet cost nothing.** A person's WhatsApp connection
only starts when they first open their page, so adding twenty people you'll
invite later doesn't hammer WhatsApp with QR codes nobody is looking at.

**After a deploy**, linked accounts reconnect about two seconds apart instead
of all at once.

**One office, one IP.** Ten wrong passwords lock *that account* from *that
address* for 15 minutes — not everyone else sharing your office internet.

## Things to know

**This is an unofficial WhatsApp client.** It's built on Baileys, a
community-maintained implementation that Meta doesn't sanction. Normal
human-paced use of your own accounts is generally fine. Bulk or automated
sending is what gets numbers banned.

**Memory.** Steady state is small (tens of MB per account). The moment someone
links, WhatsApp sends their history in large batches and memory briefly spikes —
more with bigger accounts. If a very large account makes the service restart
during linking, set `FULL_HISTORY=0` and re-link.

**How much history.** WhatsApp decides that, not this app. Usually the last
few months of every chat arrives at linking, and **Load earlier messages**
reaches further back per chat. Media in old messages downloads on demand.

**Linked devices expire** if a phone is offline for about 14 days. That person
just sees the QR screen again.

**Keep the service at one replica.** Two copies sharing a volume fight over
the encryption keys and messages stop arriving.

## Troubleshooting

Deploy logs show a line per history batch, which is the quickest way to see
what's happening:

```
  using WhatsApp Web version 2.3000.1047506285 (from web.whatsapp.com)
[ali] connected as +6591234567
[ali] history batch: type=0 chats=312 contacts=540 messages=4180 progress=35%
```

| Symptom | Fix |
| --- | --- |
| "WhatsApp closed the connection before sending a QR code" (428) | WhatsApp may reject Baileys desktop identities (`DARWIN`/`WIN32`) before emitting a QR. This build uses `Browsers.ubuntu('Chrome')` so the handshake advertises `WEB_BROWSER`, while `syncFullHistory` remains enabled. After changing the image, deploy a fresh build and use **Start over with a new QR code**. |
| Stuck on "Reconnecting…" / never shows a QR | Fixed in this version: it was using an outdated WhatsApp Web version, which WhatsApp refuses (code 405) before showing a QR. The screen now shows the actual reason. Logs should say `using WhatsApp Web version 2.3000.… (from web.whatsapp.com)`. If you still see repeated 405s, set `WA_VERSION` to the current version. |
| Still stuck after several attempts | A **Start over with a new QR code** button appears on the screen after 3 failed attempts. |
| No `history batch` lines after linking | The device was linked before this upgrade. **⋮ → Re-link WhatsApp**. |
| A chat still shows a long number instead of a name | WhatsApp hasn't revealed that LID's phone yet. It merges automatically once that person messages you. |
| "Not sent: WhatsApp is not connected yet" | The dot next to your name is amber — wait for green. |
| Photo sent as a file | Your browser couldn't decode it (often HEIC). Export as JPEG first. |
| "This account has no password yet" | Ask the admin for a setup link. |
| Everyone logged out after a deploy | The `/data` volume isn't mounted. |
| Build fails fetching libsignal | Keep `git` in the Dockerfile's `apk add` line. |
