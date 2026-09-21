# Multi-user WhatsApp Web on Railway

This project runs multiple isolated Firefox instances in one Railway service. Each instance has its own Firefox profile and therefore its own WhatsApp Web login. The profiles live on a Railway Volume mounted at `/data`.

## Deploy

1. Push this folder to a private GitHub repository.
2. In Railway, create a new project and deploy the repository.
3. Add a Railway Volume to the service and mount it at `/data`.
4. Add these environment variables:

- `ADMIN_KEY` = a long random secret (used only to create/delete sessions)
- `BASE_URL` = your public Railway/custom URL, e.g. `https://wa.example.com`
- `DATA_DIR` = `/data`
- `START_DISPLAY` = `101`
- `SCREEN` = `1366x768x24`

5. Generate a Railway public domain or attach your custom domain.
6. Create a user session:

```bash
curl -X POST \
  -H "X-Admin-Key: YOUR_ADMIN_KEY" \
  https://wa.example.com/api/sessions
```

The response contains a private session URL such as:

```text
https://wa.example.com/s/AbCdEf...
```

Give that URL to that user. On first open, Firefox will show WhatsApp Web's QR code. They scan it from their phone. After that, closing and reopening the URL reconnects to the same Firefox profile.

## Why it persists

Each session gets:

```text
/data/profiles/<session-id>/
```

That directory is the Firefox profile. It is on the Railway Volume, not ephemeral container storage.

## Important

- Do not expose `/api/sessions` publicly without the `X-Admin-Key`.
- Treat session URLs as credentials: anyone with a session URL can access that WhatsApp browser.
- Keep the Railway service at one active replica for this design because browser/X/VNC processes are local to the container.
- A Railway deployment/restart will stop browsers, but the profiles remain on the Volume and the app recreates the sessions at startup.
