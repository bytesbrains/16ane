// The kit's two sellers on a throwaway local chain (#20): bad input is refused with a 4xx before anything
// is settled, a broken facilitator is a 502 rather than a dropped connection, and two concurrent paid
// requests under one Idempotency-Key are charged once. Needs Foundry and python3, like `npm run kit:demo`.
import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import http from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";

const stateDir = mkdtempSync(path.join(tmpdir(), "16ane-kit-sellers-"));
process.env.KIT_STATE_DIR = stateDir;

// Imported after KIT_STATE_DIR is set: kit.ts reads it once, at load.
const { startLocalSandbox } = await import("../../examples/hackathon-kit/local-sandbox.ts");
const owner = await import("../../examples/hackathon-kit/owner.ts");
const { startSeller } = await import("../../examples/hackathon-kit/typescript/seller.ts");
const { KIT_DIR, clientFor, loadOrCreateKey, readAgent } = await import("../../examples/hackathon-kit/kit.ts");
const { AgentSession, computeRequestHash, computeResourceHash } = await import("../../packages/sdk-ts/src/index.ts");

type Net = Awaited<ReturnType<typeof startLocalSandbox>>["net"];
const cleanups: (() => Promise<void> | void)[] = [];
let net: Net;
let tsUrl: string;
let pyUrl: string;

// The python3 on PATH is the participant's own interpreter, as in the guide. Reviewed, not a finding.
function startPythonSeller(env: Record<string, string> = {}): Promise<{ url: string; proc: ChildProcess }> {
  const proc = spawn("python3", [path.join(KIT_DIR, "python", "seller.py")], { // NOSONAR
    env: { ...process.env, PORT: "0", ...env },
    stdio: ["ignore", "pipe", "ignore"],
  });
  cleanups.push(() => void proc.kill("SIGTERM"));
  return new Promise((resolve, reject) => {
    proc.once("exit", (code) => reject(new Error(`python seller exited (${code})`)));
    createInterface({ input: proc.stdout! }).on("line", (line) => {
      const m = line.match(/on (http:\/\/\S+):/);
      if (m) resolve({ url: m[1], proc });
    });
  });
}

async function post(url: string, body: string, headers: Record<string, string> = {}) {
  const res = await fetch(url, { method: "POST", body, headers: { "content-type": "application/json", ...headers } });
  return { status: res.status, body: (await res.json()) as { error?: { code?: string } } };
}

// A PAYMENT-SIGNATURE header bound to this exact request, with the given payload fields on top.
function paymentHeader(url: string, body: string, payload: unknown): string {
  const bound = { resourceHash: computeResourceHash("POST", url), requestHash: computeRequestHash(body) };
  const merged = payload && typeof payload === "object" && !Array.isArray(payload) ? { ...bound, ...payload } : payload;
  return Buffer.from(JSON.stringify({ x402Version: 2, payload: merged })).toString("base64");
}

async function spent(): Promise<bigint> {
  return (await clientFor(net).getAccountingSummary(readAgent().vaultAddress)).cumulativeSpent;
}

before(async () => {
  const sandbox = await startLocalSandbox();
  cleanups.push(sandbox.stop);
  net = sandbox.net;
  await owner.setup(net, () => {});
  const ts = await startSeller(0);
  cleanups.push(ts.close);
  tsUrl = ts.url;
  pyUrl = (await startPythonSeller()).url;
});

after(async () => {
  for (const fn of cleanups.reverse()) await fn();
  rmSync(stateDir, { recursive: true, force: true });
});

for (const seller of ["TypeScript", "Python"] as const) {
  const url = () => (seller === "TypeScript" ? tsUrl : pyUrl);

  test(`${seller} seller: a body that is not a JSON object is a 400, before any quote or charge`, async () => {
    const before = await spent();
    const session = new AgentSession({ client: clientFor(net), vaultAddress: readAgent().vaultAddress, sessionKey: loadOrCreateKey("agent") });
    for (const body of ["not json", "[1, 2]", '"text"']) {
      // A real buyer would pay any 402 it got here; the seller must refuse the body before quoting.
      const res = await session.purchase(url(), { method: "POST", body, maxPayment: owner.PER_PAYMENT });
      assert.equal(res.status, 400, `${seller} answered ${res.status} to ${body}`);
      assert.equal((res.data as { error?: { code?: string } }).error?.code, "ANE-E-4001");
    }
    assert.equal(await spent(), before);
  });

  test(`${seller} seller: a body over 64 KiB is a 413`, async () => {
    const res = await post(url(), JSON.stringify({ text: "x".repeat(70 * 1024) }));
    assert.equal(res.status, 413);
  });

  test(`${seller} seller: a malformed payment is a 4xx, never a 500`, async () => {
    const body = JSON.stringify({ text: "2024" });
    for (const payload of [{ amount: "lots" }, { amount: -1 }, [1, 2], "a string", null]) {
      const res = await post(url(), body, { "payment-signature": paymentHeader(url(), body, payload) });
      assert.ok(res.status >= 400 && res.status < 500, `${seller} answered ${res.status} to ${JSON.stringify(payload)}`);
    }
  });

  test(`${seller} seller: concurrent paid requests with one Idempotency-Key are charged once`, async () => {
    const before = await spent();
    const session = new AgentSession({ client: clientFor(net), vaultAddress: readAgent().vaultAddress, sessionKey: loadOrCreateKey("agent") });
    const body = JSON.stringify({ text: "Room 2024" });
    const idempotencyKey = `idem-race-${seller}`;
    const results = await Promise.allSettled(
      [0, 1, 2].map(() => session.purchase(url(), { method: "POST", body, idempotencyKey, maxPayment: owner.PER_PAYMENT })),
    );
    const statuses = results.map((r) => (r.status === "fulfilled" ? r.value.status : "rejected"));
    assert.ok(statuses.includes(200), `no purchase succeeded: ${statuses.join(", ")}`);
    const price = (seller === "TypeScript" ? 16n : 8n) * 10n ** 18n;
    assert.equal(await spent(), before + price, `statuses ${statuses.join(", ")}`);
  });
}

test("Python seller: a facilitator that is down or answers garbage is a 502, and nothing is charged", async () => {
  const garbage = http.createServer((_req, res) => res.writeHead(500, { "content-type": "text/html" }).end("<h1>oops</h1>"));
  await new Promise<void>((resolve) => garbage.listen(0, "127.0.0.1", resolve));
  cleanups.push(() => new Promise<void>((resolve) => garbage.close(() => resolve())));
  const port = (garbage.address() as { port: number }).port;
  const before = await spent();
  for (const facilitator of [`http://127.0.0.1:${port}`, "http://127.0.0.1:9"]) {
    const { url } = await startPythonSeller({ FACILITATOR_URL: facilitator });
    const session = new AgentSession({ client: clientFor(net), vaultAddress: readAgent().vaultAddress, sessionKey: loadOrCreateKey("agent") });
    const res = await session.purchase(url, { method: "POST", body: JSON.stringify({ text: "1" }), maxPayment: owner.PER_PAYMENT }).then(
      (r) => r.status,
      (err: Error) => err.message,
    );
    assert.match(String(res), /502|ANE-E-4009/, `facilitator ${facilitator}: ${res}`);
  }
  assert.equal(await spent(), before);
});
