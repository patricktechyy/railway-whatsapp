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
contact name. This build uses Baileys 7, links as a desktop client (which is what
makes WhatsApp send the proper backlog), and explicitly accepts every history
type. Every time WhatsApp reveals that a LID belongs to a phone number, the two
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
| Fix a typo in a name | **Rename**. The username can't change (it's in their URL). |
| Remove someone | **Remove** → type their username to confirm. Unlinks their phone and deletes their data here. |

Setup links work once and expire after 7 days. You can't read anyone's chats
from the admin page. (You *could* reset someone's password and use the link
yourself — they'd notice, because it signs them out.)

## Variables

| Variable | Default | |
| --- | --- | --- |
| `ADMIN_PASSWORD` | generated | Admin login. The old `PASSWORD` still works. |
| `BRAND` | `WhatsApp Hub` | Name on the login page. |
| `FULL_HISTORY` | `1` | `0` takes only recent history at pairing (lighter on very large accounts). |
| `MAX_MSGS_PER_CHAT` | `150` | Messages kept per chat on the server. |
| `MAX_CHATS` | `800` | Chats kept. |
| `MAX_UPLOAD_MB` | `25` | Largest file you can send. |
| `DATA_DIR` | `/data` | Must match the volume mount. |

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
[ali] connected as +6591234567
[ali] history batch: type=0 chats=312 contacts=540 messages=4180 progress=35%
```

| Symptom | Fix |
| --- | --- |
| No `history batch` lines after linking | The device was linked before this upgrade. **⋮ → Re-link WhatsApp**. |
| A chat still shows a long number instead of a name | WhatsApp hasn't revealed that LID's phone yet. It merges automatically once that person messages you. |
| "Not sent: WhatsApp is not connected yet" | The dot next to your name is amber — wait for green. |
| Photo sent as a file | Your browser couldn't decode it (often HEIC). Export as JPEG first. |
| "This account has no password yet" | Ask the admin for a setup link. |
| Everyone logged out after a deploy | The `/data` volume isn't mounted. |
| Build fails fetching libsignal | Keep `git` in the Dockerfile's `apk add` line. |
