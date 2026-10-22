// Tier-2 global teardown: the sandbox and dashboard servers die with the main
// process, but Anvil is a spawned child that would orphan — kill it by PID.
import { readFileSync } from "node:fs";
import path from "node:path";

export default async function globalTeardown(): Promise<void> {
  const file = path.resolve(
    import.meta.dirname,
    "..",
    "..",
    "..",
    "test-results",
    "tier2-stack.json",
  );
  let pid: unknown;
  try {
    pid = (JSON.parse(readFileSync(file, "utf8")) as { anvilPid?: unknown }).anvilPid;
  } catch {
    return;
  }
  if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0) return;
  try {
    process.kill(pid, "SIGTERM");
  } catch {
    // Already gone (or never started): teardown is best-effort.
  }
}
