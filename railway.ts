import { defineRailway, github, project, service, volume } from 'railway/iac'

/**
 * Railway Infrastructure as Code.
 *   npm install && railway login && railway link
 *   railway config apply --file railway.ts
 *
 * /data holds every account's WhatsApp credentials, chat snapshot and the
 * users list. Without the volume, every deploy logs everyone out.
 */
const REPO = process.env.WA_REPO ?? 'YOUR-GITHUB-USERNAME/railway-whatsapp'

export default defineRailway(() => {
  const data = volume('wa-data', {
    sizeMB: Number(process.env.WA_VOLUME_MB ?? 1024),
    ...(process.env.WA_REGION ? { region: process.env.WA_REGION } : {}),
  })

  const app = service('wa-lite', {
    source: github(REPO, { branch: process.env.WA_BRANCH ?? 'main' }),
    healthcheck: '/healthz',
    healthcheckTimeout: 120,
    volumeMounts: { '/data': data },
    env: {
      BRAND: process.env.WA_BRAND ?? 'Apa yang Diatas (Whats Up)',
      // ADMIN_PASSWORD is deliberately not here so it never lands in git.
      // Set it in the Railway dashboard.
    },
  })

  return project(process.env.WA_PROJECT ?? 'wa-lite', { resources: [app, data] })
})
