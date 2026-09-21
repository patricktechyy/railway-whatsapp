import { defineRailway, github, project, service, volume } from "railway/iac";

/**
 * Railway Infrastructure as Code for wa-hub.
 *
 * Apply with:
 *   npm install
 *   railway login && railway link
 *   railway config apply
 *
 * The important part is `volumeMounts` — it mounts a persistent volume at
 * /data, which is where every browser profile (and therefore every WhatsApp
 * login) lives. Without it, a redeploy logs everyone out.
 */

// Set these before applying, or export them in your shell.
const REPO = process.env.WA_HUB_REPO ?? "YOUR-GITHUB-USERNAME/wa-hub";
const BRANCH = process.env.WA_HUB_BRANCH ?? "main";
const SESSIONS = process.env.WA_HUB_SESSIONS ?? "3";
const NAMES = process.env.WA_HUB_NAMES ?? "";
const VOLUME_MB = Number(process.env.WA_HUB_VOLUME_MB ?? 2048);

// Optional: pin the volume to a region close to your users, e.g.
// WA_HUB_REGION=southeast-asia-... (copy the exact id from the Railway
// dashboard when it offers you a region). Left unset, Railway picks one.
const REGION = process.env.WA_HUB_REGION;

export default defineRailway(() => {
  const data = volume("wa-hub-data", {
    sizeMB: VOLUME_MB,
    ...(REGION ? { region: REGION } : {}),
  });

  const hub = service("wa-hub", {
    source: github(REPO, { branch: BRANCH }),
    healthcheck: "/healthz",
    healthcheckTimeout: 300,
    volumeMounts: {
      "/data": data,
    },
    env: {
      SESSIONS,
      NAMES,
      BRAND: process.env.WA_HUB_BRAND ?? "WhatsApp Hub",
      SCREEN: process.env.WA_HUB_SCREEN ?? "1440x900x24",
      KIOSK: process.env.WA_HUB_KIOSK ?? "1",
      // PASSWORD is deliberately NOT set here so it never lands in git.
      // Set it in the Railway dashboard, or let the container generate one
      // and print it to the deploy logs on first boot.
    },
  });

  return project(process.env.WA_HUB_PROJECT ?? "wa-hub", {
    resources: [hub, data],
  });
});
