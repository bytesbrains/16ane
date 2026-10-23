// Tier-2 global setup: reuses the runner-held stack when it is live, else cold
// boots (direct `playwright test -c playwright.tier2.config.ts` still needs a
// separately built wallet cache — prefer `npm run test:e2e:dashboard-tier2`).
import { bootTier2Stack, liveStackPresent } from "./tier2-boot.ts";

export default async function globalSetup(): Promise<void> {
  if (await liveStackPresent()) return;
  await bootTier2Stack();
}
