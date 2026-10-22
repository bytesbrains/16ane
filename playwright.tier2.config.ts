import { defineConfig } from "@playwright/test";

// Standalone config for the Tier-2 (real MetaMask) dashboard suite. Tier-2
// lives apart from playwright.config.ts because its specs are CJS (see
// test/dashboard/e2e/metamask/tier2.spec.ts) and its Anvil stack boots in an
// ESM global setup instead of in-file. Run via `npm run test:e2e:dashboard-tier2`
// (headed Chromium under xvfb in CI).
export default defineConfig({
  testDir: "test/dashboard/e2e/metamask",
  globalSetup: "./test/dashboard/e2e/tier2-global-setup.ts",
  globalTeardown: "./test/dashboard/e2e/tier2-global-teardown.ts",
  timeout: 180_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? "github" : "list",
  use: {
    // Extensions need a headed browser; CI runs this config under xvfb.
    headless: false,
    trace: "retain-on-failure",
    launchOptions: {
      args: ["--disable-dev-shm-usage"],
    },
  },
});
