import { defineConfig } from '@playwright/test'

// Optional Playwright-managed gateway. Set JINN_E2E_START_GATEWAY=1 to have
// Playwright spawn the gateway on :7779 with JINN_E2E=1 (which unlocks the
// PUT /api/sessions/:id error-state seeding fields used by e2e/error-resume.spec.ts).
// When unset, tests assume a gateway is already running on the URL below — matches
// the prior behavior for `smoke.spec.ts`.
const START_GATEWAY = process.env.JINN_E2E_START_GATEWAY === '1'

export default defineConfig({
  testDir: './e2e',
  timeout: 30_000,
  use: {
    baseURL: 'http://localhost:7779',
    headless: true,
  },
  ...(START_GATEWAY
    ? {
        webServer: {
          command: 'node packages/jimmy/dist/bin/jimmy.js start --port 7779',
          url: 'http://localhost:7779/api/status',
          reuseExistingServer: !process.env.CI,
          timeout: 60_000,
          env: {
            JINN_E2E: '1',
          },
        },
      }
    : {}),
})
