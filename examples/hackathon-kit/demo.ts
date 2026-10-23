// The whole kit in one command (#20), on a throwaway local chain: start the sandbox, set up an owner and
// an agent, start both sellers, let both buyers pay both sellers and the demo API, show that the budget
// holds, revoke, and return the funds. CI runs this and fails it past the five-minute budget.
//
//   npm run kit:demo
//
// It keeps its state in a temporary directory, so it never touches your own .kit/.
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";

const BUDGET_MS = 5 * 60 * 1000;
const started = Date.now();
const stateDir = mkdtempSync(path.join(tmpdir(), "16ane-kit-"));
process.env.KIT_STATE_DIR = stateDir;

// Imported after KIT_STATE_DIR is set: kit.ts reads it once, at load.
const { startLocalSandbox } = await import("./local-sandbox.ts");
const owner = await import("./owner.ts");
const { startSeller } = await import("./typescript/seller.ts");
const { buy } = await import("./typescript/buyer.ts");
const { KIT_DIR, SANDBOX_DISCLAIMER } = await import("./kit.ts");

const step = (label: string) => console.log(`\n[${((Date.now() - started) / 1000).toFixed(1)}s] ${label}`);
const cleanups: (() => Promise<void> | void)[] = [];

function check(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
  console.log(`  ok: ${message}`);
}

// Starts the Python seller on a free port and resolves with its URL once it is listening.
// Both spawns run the participant's own python3 from PATH, as the guide does, with a fixed argument list
// and no shell. Reviewed, not a finding.
function startPythonSeller(): Promise<{ url: string; proc: ChildProcess }> {
  const proc = spawn("python3", [path.join(KIT_DIR, "python", "seller.py")], { // NOSONAR
    env: { ...process.env, PORT: "0" },
    stdio: ["ignore", "pipe", "inherit"],
  });
  return new Promise((resolve, reject) => {
    proc.once("exit", (code) => reject(new Error(`python seller exited (${code})`)));
    createInterface({ input: proc.stdout! }).on("line", (line) => {
      console.log(`  ${line}`);
      const m = line.match(/on (http:\/\/\S+):/);
      if (m) resolve({ url: m[1], proc });
    });
  });
}

function runPythonBuyer(url: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const proc = spawn("python3", [path.join(KIT_DIR, "python", "buyer.py"), url, "Room 2024, floor 16"], { // NOSONAR
      stdio: ["ignore", "pipe", "inherit"],
    });
    let out = "";
    proc.stdout!.on("data", (d: Buffer) => (out += d.toString()));
    proc.once("exit", (code) => (code === 0 ? resolve(out) : reject(new Error(`python buyer failed (${code}):\n${out}`))));
  });
}

try {
  console.log(SANDBOX_DISCLAIMER);
  step("1. start a local sandbox: chain, contracts, sandbox API, facilitator");
  const { net, stop } = await startLocalSandbox();
  cleanups.push(stop);

  step("2. the owner claims test tANE, creates and funds a vault, and delegates a budget (all gasless)");
  await owner.setup(net, (line) => console.log(`  ${line}`));

  step("3. start the sellers");
  const tsSeller = await startSeller(0);
  cleanups.push(tsSeller.close);
  console.log(`  TypeScript seller on ${tsSeller.url}`);
  const pySeller = await startPythonSeller();
  cleanups.push(() => void pySeller.proc.kill("SIGTERM"));

  step("4. the TypeScript buyer pays the demo API and both sellers");
  const demo = await buy(`${net.apiUrl}/v1/demo/summarize`, { text: "Sixteen annas made one rupee." });
  check(demo.status === 200 && Boolean(demo.txHash), "demo API: paid 16 tANE and got a summary");
  const words = await buy(tsSeller.url, { text: "agents pay each other in test tokens" });
  check(words.status === 200 && (words.data as { words: number }).words === 7, "TypeScript seller: paid 16 tANE, counted 7 words");
  const digits = await buy(pySeller.url, { text: "Room 2024" });
  check(digits.status === 200 && (digits.data as { text: string }).text === "Room २०२४", "Python seller: paid 8 tANE, got Devanagari digits");

  step("5. the Python buyer pays both sellers");
  const pyOut = await runPythonBuyer(pySeller.url);
  check(pyOut.includes("२०२४"), "Python buyer -> Python seller");
  check((await runPythonBuyer(tsSeller.url)).includes('"status": 200'), "Python buyer -> TypeScript seller");

  step("6. the contract, not the agent, holds the budget");
  const s = await owner.status(net, (line) => console.log(`  ${line}`));
  const spent = (16n + 16n + 8n + 8n + 16n) * 10n ** 18n;
  check(s.cumulativeSpent === spent, "the vault recorded exactly 64 tANE of agent spending");
  check(s.spendableNow === owner.BUDGET - spent, "the agent may spend only what is left of its 320 tANE budget");

  step("7. the owner revokes the agent and takes the rest back");
  await owner.revoke(net, (line) => console.log(`  ${line}`));
  const refused = await buy(tsSeller.url, { text: "one more" }).then(
    () => false,
    () => true,
  );
  check(refused, "a revoked agent cannot pay any more");
  await owner.withdraw(net, (line) => console.log(`  ${line}`));
  check((await owner.status(net, () => {})).tokenBalance === 0n, "the vault is empty; the owner has the remaining tANE");

  const elapsed = Date.now() - started;
  step(`done in ${(elapsed / 1000).toFixed(1)}s`);
  check(elapsed < BUDGET_MS, "the whole workshop journey ran in under five minutes");
} catch (err) {
  console.error(`\nkit demo failed: ${err instanceof Error ? err.stack : String(err)}`);
  process.exitCode = 1;
} finally {
  for (const fn of cleanups.reverse()) await fn();
  rmSync(stateDir, { recursive: true, force: true });
}
