import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import {
  buildSentryEnvelope,
  createSentryReporter,
  parseSentryDsn,
  postSentryEnvelope,
  scrubErrorDetail,
  type SentryFetch,
} from "../src/sentry.ts";
import { createSandboxServer } from "../src/server.ts";

const SAMPLE_DSN = "https://pubKeyExample1234567890abcd@o0.ingest.sentry.io/12345";
const LEAKY_URL = "https://rpc.example.invalid/v3/sk_live_DO_NOT_LEAK";
const PRIVATE_KEY = "0x" + "ab".repeat(32);
const SIGNATURE = "0x" + "cd".repeat(65);
const word = (n: number) => n.toString(16).padStart(64, "0");

test("parseSentryDsn accepts a standard https DSN and rejects junk", () => {
  const parsed = parseSentryDsn(SAMPLE_DSN);
  assert.ok(parsed);
  assert.equal(parsed.publicKey, "pubKeyExample1234567890abcd");
  assert.equal(parsed.host, "o0.ingest.sentry.io");
  assert.equal(parsed.projectId, "12345");
  assert.equal(parsed.envelopeUrl, "https://o0.ingest.sentry.io/api/12345/envelope/");

  assert.equal(parseSentryDsn(undefined), undefined);
  assert.equal(parseSentryDsn(""), undefined);
  assert.equal(parseSentryDsn("not-a-url"), undefined);
  assert.equal(parseSentryDsn("https://nokey@host/"), undefined);
  assert.equal(parseSentryDsn("ftp://key@host/1"), undefined);
});

test("scrubErrorDetail redacts URLs and 32-byte-or-longer hex, leaves addresses alone", () => {
  assert.equal(
    scrubErrorDetail(`cast send --rpc-url ${LEAKY_URL} key=${PRIVATE_KEY}`),
    "cast send --rpc-url <url> key=<hex>",
  );
  assert.equal(scrubErrorDetail(`sig ${SIGNATURE}`), "sig <hex>");
  // Signed transactions and calldata run past 65 bytes: no upper bound may let them through.
  const calldata = "0x" + "ef".repeat(100);
  assert.equal(scrubErrorDetail(`calldata ${calldata}`), "calldata <hex>");
  // A secret followed by a non-hex word char still redacts (no trailing word boundary required).
  assert.equal(scrubErrorDetail(`key=${PRIVATE_KEY}g`), "key=<hex>g");
  const addr = "0x" + "11".repeat(20);
  assert.equal(scrubErrorDetail(`to ${addr}`), `to ${addr}`);
});

test("buildSentryEnvelope carries only code, errorId and a scrubbed message — no request fields", () => {
  const dsn = parseSentryDsn(SAMPLE_DSN)!;
  const errorId = "071e025d-c2a7-4e66-ba52-0f91d3dd1b65";
  const { event, envelope } = buildSentryEnvelope(
    {
      code: "ANE-E-5000",
      errorId,
      detail: `boom at ${LEAKY_URL} with ${PRIVATE_KEY}`,
    },
    dsn,
  );

  assert.equal(event.event_id, errorId.replace(/-/g, ""));
  assert.deepEqual(event.tags, { errorId, code: "ANE-E-5000" });
  assert.equal((event.message as { formatted: string }).formatted, "boom at <url> with <hex>");
  assert.equal(event.request, undefined);
  assert.equal(event.user, undefined);
  assert.equal(event.contexts, undefined);
  assert.equal(event.extra, undefined);
  assert.equal(event.breadcrumbs, undefined);

  const blob = JSON.stringify(event);
  assert.doesNotMatch(
    blob,
    /DO_NOT_LEAK|sk_live|rpc\.example|ababab|headers|Authorization|fly-client-ip|turnstile|remoteAddress|query_string|cookies/i,
  );

  const lines = envelope.trimEnd().split("\n");
  assert.equal(lines.length, 3);
  assert.equal(JSON.parse(lines[1]).type, "event");
});

test("createSentryReporter is a no-op when the DSN is unset", () => {
  assert.equal(createSentryReporter(undefined), undefined);
  assert.equal(createSentryReporter(""), undefined);
});

test("createSentryReporter POSTs a scrubbed envelope without excluded fields", async () => {
  const posts: { url: string; headers: Record<string, string>; body: string }[] = [];
  const fetchImpl: SentryFetch = async (url, init) => {
    posts.push({ url, headers: init.headers, body: init.body });
    return { ok: true, status: 200 };
  };
  const report = createSentryReporter(SAMPLE_DSN, fetchImpl);
  assert.ok(report);

  report({
    code: "ANE-E-1004",
    errorId: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
    detail: `upstream ${LEAKY_URL} key=${PRIVATE_KEY} Authorization: Bearer secret turnstileToken=tok`,
  });
  await new Promise((r) => setImmediate(r));

  assert.equal(posts.length, 1);
  assert.equal(posts[0].url, "https://o0.ingest.sentry.io/api/12345/envelope/");
  assert.match(posts[0].headers["x-sentry-auth"], /sentry_key=pubKeyExample1234567890abcd/);
  assert.doesNotMatch(posts[0].body, /DO_NOT_LEAK|sk_live|ababab|Bearer secret|turnstileToken/);
  assert.match(posts[0].body, /ANE-E-1004/);
  assert.match(posts[0].body, /aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee/);
  assert.match(posts[0].body, /<url>/);
  assert.match(posts[0].body, /<hex>/);
  assert.doesNotMatch(posts[0].body, /"request"|fly-client-ip|x-forwarded-for/i);
});

test("sendLoggedError posts to Sentry when sentryDsn is set, and never when unset", async () => {
  const posts: string[] = [];
  const fetchImpl: SentryFetch = async (_url, init) => {
    posts.push(init.body);
    return { ok: true, status: 200 };
  };

  // Fake RPC: healthy for deploy resolution, then fails so the faucet hits sendLoggedError.
  const rpc = await startFlakyRpc();
  const rpcUrl = rpc.rpcUrl;

  const withSentry = await createSandboxServer({
    rpcUrl,
    registryAddress: "0x" + "ab".repeat(20),
    relayerPrivateKey: "0x" + "1".repeat(64),
    faucetOpenClaims: true,
    sentryDsn: SAMPLE_DSN,
    sentryFetch: fetchImpl,
  });
  rpc.setHealthy(false);
  try {
    const { status, error } = await postFaucetClaim(withSentry.url);
    assert.equal(status, 502);
    assert.equal(error.code, "ANE-E-1004");
    await new Promise((r) => setImmediate(r));
    assert.equal(posts.length, 1);
    assert.match(posts[0], new RegExp(error.errorId));
    assert.doesNotMatch(posts[0], /DO_NOT_LEAK|ababab|"request"/);
  } finally {
    await withSentry.close();
  }

  // Unset DSN: same failure path, no Sentry POST.
  posts.length = 0;
  rpc.setHealthy(true);
  const noSentry = await createSandboxServer({
    rpcUrl,
    registryAddress: "0x" + "ab".repeat(20),
    relayerPrivateKey: "0x" + "1".repeat(64),
    faucetOpenClaims: true,
    sentryFetch: fetchImpl,
  });
  rpc.setHealthy(false);
  try {
    const { status } = await postFaucetClaim(noSentry.url);
    assert.equal(status, 502);
    await new Promise((r) => setImmediate(r));
    assert.equal(posts.length, 0);
  } finally {
    await noSentry.close();
    await rpc.close();
  }
});

test("postSentryEnvelope warns without the DSN on a non-2xx ingest response, stays quiet on success", async () => {
  const dsn = parseSentryDsn(SAMPLE_DSN)!;
  const report = { code: "ANE-E-5000", errorId: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee", detail: "boom" };
  const warnings: string[] = [];
  const origWarn = console.warn;
  console.warn = (...args: unknown[]) => {
    warnings.push(args.map(String).join(" "));
  };
  try {
    await postSentryEnvelope(dsn, report, async () => ({ ok: false, status: 500 }));
    await postSentryEnvelope(dsn, report, async () => ({ ok: true, status: 200 }));
  } finally {
    console.warn = origWarn;
  }
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /HTTP 500/);
  assert.doesNotMatch(warnings[0], /pubKeyExample|ingest\.sentry\.io|12345/);
});

// Fake RPC: healthy for deploy resolution and startup, then fails so the faucet hits sendLoggedError.
async function startFlakyRpc(): Promise<{
  rpcUrl: string;
  setHealthy: (h: boolean) => void;
  close: () => Promise<void>;
}> {
  let healthy = true;
  const rpc = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      if (!healthy) {
        res.writeHead(500, { "content-type": "text/plain" });
        res.end(`upstream error at ${LEAKY_URL} key=${PRIVATE_KEY}`);
        return;
      }
      const { id } = JSON.parse(body) as { id: number };
      const result = "0x" + word(0x11) + word(0x22) + word(0x33) + word(0x44);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ jsonrpc: "2.0", id, result }));
    });
  });
  await new Promise<void>((resolve) => rpc.listen(0, "127.0.0.1", () => resolve()));
  const { port } = rpc.address() as AddressInfo;
  return {
    rpcUrl: `http://127.0.0.1:${port}`,
    setHealthy: (h: boolean) => {
      healthy = h;
    },
    close: () => new Promise<void>((resolve) => rpc.close(() => resolve())),
  };
}

async function postFaucetClaim(url: string): Promise<{ status: number; error: { errorId: string; code: string } }> {
  const res = await fetch(`${url}/v1/faucet/claims`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ recipient: "0x" + "cd".repeat(20) }),
  });
  const { error } = (await res.json()) as { error: { errorId: string; code: string } };
  return { status: res.status, error };
}

test("two servers in one process report to their own Sentry sinks, never each other's", async () => {
  const postsA: { url: string; body: string }[] = [];
  const postsB: { url: string; body: string }[] = [];
  const fetchA: SentryFetch = async (url, init) => {
    postsA.push({ url, body: init.body });
    return { ok: true, status: 200 };
  };
  const fetchB: SentryFetch = async (url, init) => {
    postsB.push({ url, body: init.body });
    return { ok: true, status: 200 };
  };

  const rpc = await startFlakyRpc();
  const base = {
    rpcUrl: rpc.rpcUrl,
    registryAddress: "0x" + "ab".repeat(20),
    relayerPrivateKey: "0x" + "1".repeat(64),
    faucetOpenClaims: true,
  };
  const a = await createSandboxServer({
    ...base,
    sentryDsn: "https://keyA000000000000000000000001@o0.ingest.sentry.io/111",
    sentryFetch: fetchA,
  });
  const b = await createSandboxServer({
    ...base,
    sentryDsn: "https://keyB000000000000000000000002@o0.ingest.sentry.io/222",
    sentryFetch: fetchB,
  });
  rpc.setHealthy(false);
  try {
    const sentA = await postFaucetClaim(a.url);
    assert.equal(sentA.status, 502);
    const sentB = await postFaucetClaim(b.url);
    assert.equal(sentB.status, 502);
    const errA = sentA.error;
    const errB = sentB.error;
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    assert.equal(postsA.length, 1);
    assert.equal(postsB.length, 1);
    assert.match(postsA[0].url, /\/111\/envelope\/$/);
    assert.match(postsB[0].url, /\/222\/envelope\/$/);
    assert.match(postsA[0].body, new RegExp(errA.errorId));
    assert.match(postsB[0].body, new RegExp(errB.errorId));
    assert.doesNotMatch(postsA[0].body, new RegExp(errB.errorId));
    assert.doesNotMatch(postsB[0].body, new RegExp(errA.errorId));
  } finally {
    await a.close();
    await b.close();
    await rpc.close();
  }
});

test("a failed startup leaves no sink behind: other servers' errors stay local", async () => {
  const posts: string[] = [];
  const fetchImpl: SentryFetch = async (_url, init) => {
    posts.push(init.body);
    return { ok: true, status: 200 };
  };
  const rpc = await startFlakyRpc();
  const healthyServer = await createSandboxServer({
    rpcUrl: rpc.rpcUrl,
    registryAddress: "0x" + "ab".repeat(20),
    relayerPrivateKey: "0x" + "1".repeat(64),
    faucetOpenClaims: true,
  });
  // Nothing listens here, so resolveContracts fails and startup rejects.
  await assert.rejects(
    createSandboxServer({
      rpcUrl: "http://127.0.0.1:1/",
      registryAddress: "0x" + "ab".repeat(20),
      relayerPrivateKey: "0x" + "1".repeat(64),
      sentryDsn: SAMPLE_DSN,
      sentryFetch: fetchImpl,
    }),
  );
  rpc.setHealthy(false);
  try {
    const { status } = await postFaucetClaim(healthyServer.url);
    assert.equal(status, 502);
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    assert.equal(posts.length, 0);
  } finally {
    await healthyServer.close();
    await rpc.close();
  }
});
