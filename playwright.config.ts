import { defineConfig, devices } from "@playwright/test";

const PORT = 5288;

/**
 * Timings are shortened (see `timings()` in workers/lib/config.ts) so doors
 * open in 3s and admissions/holds expire in seconds instead of minutes.
 * Every test uses its own event id, so each gets a fresh queue and seat map.
 */
export const TEST_TIMINGS = {
  QUEUE_WARMUP_MS: 3_000,
  QUEUE_TICK_MS: 300,
  QUEUE_BATCH_SIZE: 4,
  ADMISSION_TOKEN_TTL_MS: 12_000,
  HOLD_DURATION_MS: 6_000,
};

export default defineConfig({
  testDir: "./e2e",
  timeout: 60_000,
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? "github" : "list",
  use: {
    baseURL: `http://localhost:${PORT}`,
    trace: "retain-on-failure",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    command: `npx react-router dev --port ${PORT} --strictPort`,
    url: `http://localhost:${PORT}/`,
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
    env: {
      // Merged into the Worker's vars by vite.config.ts (dev server only).
      E2E_TIMINGS: JSON.stringify(
        Object.fromEntries(Object.entries(TEST_TIMINGS).map(([k, v]) => [k, String(v)])),
      ),
      // Used when there is no .dev.vars (e.g. CI); a local .dev.vars wins.
      ADMISSION_TOKEN_SECRET: process.env.ADMISSION_TOKEN_SECRET ?? "playwright-test-secret",
    },
  },
});
