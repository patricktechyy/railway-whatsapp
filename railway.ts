import { defineRailway, github, project, service, volume } from 'railway/iac'

/**
 * Railway Infrastructure as Code for wa-lite.
 *
 *   npm install
 *   railway login && railway link
 *   railway config apply
 *
 * The part that matters is `volumeMounts`: it mounts a persistent volume at
 * /data, where each session's WhatsApp credentials live. Without it, everyone
 * has to re-scan their QR code after every deploy.
 */

const REPO = process.env.WA_REPO ?? 'YOUR-GITHUB-USERNAME/wa-lite'
const BRANCH = process.env.WA_BRANCH ?? 'main'
const SESSIONS = process.env.WA_SESSIONS ?? '3'
const NAMES = process.env.WA_NAMES ?? ''
const VOLUME_MB = Number(process.env.WA_VOLUME_MB ?? 1024)

// Optional. Copy the exact region id from the Railway dashboard if you want
// the volume near your users; left unset, Railway picks one.
const REGION = process.env.WA_REGION

export default defineRailway(() => {
  const data = volume('wa-lite-data', {
    sizeMB: VOLUME_MB,
    ...(REGION ? { region: REGION } : {}),
  })

  const app = service('wa-lite', {
    source: github(REPO, { branch: BRANCH }),
    healthcheck: '/healthz',
    healthcheckTimeout: 120,
    volumeMounts: {
      '/data': data,
    },
    env: {
      SESSIONS,
      NAMES,
      BRAND: process.env.WA_BRAND ?? 'WhatsApp Hub',
      // PASSWORD is deliberately not set here, so it never lands in git.
      // Set it in the Railway dashboard, or let the app generate one and
      // print it to the deploy logs on first boot.
    },
  })

  return project(process.env.WA_PROJECT ?? 'wa-lite', {
    resources: [app, data],
  })
})
