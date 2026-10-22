import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "test/dashboard/e2e",
  timeout: 120_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? "github" : "list",
  use: {
    // Browsers cannot bind locally in some sandboxes; tests that need Anvil or a
    // static server (tier1) run in CI, while smoke.* is hermetic file:// + stubs.
    trace: "retain-on-failure",
  },
  projects: [
    {
      name: "smoke",
      testMatch: ["smoke.spec.ts", "a11y.spec.ts"],
      use: {
        launchOptions: {
          // file:// ES module imports need explicit file access.
          args: ["--allow-file-access-from-files"],
        },
      },
    },
    {
      name: "tier1",
      testMatch: "tier1.spec.ts",
    },
  ],
});
