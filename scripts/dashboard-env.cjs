#!/usr/bin/env node
// Writes the dashboard for one environment: a copy of dashboard/ in which only two things
// differ, assets/network.js (from networks/<env>.json) and the connect-src of the CSP in
// _headers (that environment's RPC and API). Everything else is byte-for-byte what ships.
// dashboard/ itself is the sandbox-sepolia build, committed: test/dashboard/site.test.ts
// requires its two generated files (assets/network.js, _headers) to match the
// `sandbox-sepolia` build exactly.
//
//   node scripts/dashboard-env.cjs <local|dev-sepolia|sandbox-sepolia> <outDir> [options]
//   node scripts/dashboard-env.cjs --network-file <path> <outDir> [options]
//
// Options:
//   --rpc-url <url>        Override the JSON-RPC endpoint (any env; must be https unless local)
//   --api-url <url>        Override the sandbox REST API base (defaults to https://api.16ane.com
//                          for sandbox-sepolia; required for other envs)
//   --network-file <path>  Read complete network settings from <path> instead of networks/<env>.json
//                          (used by harnesses that deploy first and know the addresses)
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.join(__dirname, "..");
const DASHBOARD = path.join(ROOT, "dashboard");
const DEFAULT_API_URL = "https://api.16ane.com";
// Keys copied into network.js, in canonical order so output never depends on input order.
const KEYS = [
  "name",
  "environment",
  "chainId",
  "caip2",
  "chainName",
  "rpcUrl",
  "explorer",
  "explorerName",
  "registryAddress",
  "contracts",
  "assetSymbol",
  "assetDecimals",
  "apiUrl",
];
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;

function fail(message) {
  console.error(`dashboard-env: ${message}`);
  process.exit(1);
}

function parseArgs(argv) {
  const args = { env: null, outDir: null, rpcUrl: null, apiUrl: null, networkFile: null };
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--rpc-url" || arg === "--api-url" || arg === "--network-file") {
      const value = argv[i + 1];
      if (!value || value.startsWith("--")) fail(`${arg} needs a value`);
      if (arg === "--rpc-url") args.rpcUrl = value;
      if (arg === "--api-url") args.apiUrl = value;
      if (arg === "--network-file") args.networkFile = value;
      i++;
    } else if (arg.startsWith("--")) {
      fail(`unknown flag ${arg}`);
    } else {
      positional.push(arg);
    }
  }
  if (args.networkFile) {
    if (positional.length !== 1) fail("usage with --network-file: <outDir>");
    args.outDir = positional[0];
  } else {
    if (positional.length !== 2) fail("usage: <env> <outDir> [--rpc-url ...] [--api-url ...]");
    [args.env, args.outDir] = positional;
  }
  return args;
}

function loadSettings(args) {
  const file = args.networkFile
    ? path.resolve(args.networkFile)
    : path.join(ROOT, "networks", `${path.basename(args.env)}.json`);
  if (!fs.existsSync(file)) fail(`no network settings (${file})`);
  const net = JSON.parse(fs.readFileSync(file, "utf8"));
  if (args.rpcUrl) net.rpcUrl = args.rpcUrl;
  net.apiUrl = args.apiUrl ?? (net.name === "sandbox-sepolia" ? DEFAULT_API_URL : undefined);
  validate(net);
  return Object.fromEntries(KEYS.map((k) => [k, net[k] ?? null]));
}

function validate(net) {
  for (const key of ["name", "environment", "chainId", "caip2", "chainName", "rpcUrl"]) {
    if (net[key] === undefined || net[key] === null || net[key] === "") {
      fail(`network settings need ${key}`);
    }
  }
  if (!Number.isSafeInteger(net.chainId) || net.chainId <= 0) fail(`chainId ${net.chainId}`);
  const local = net.name === "local";
  for (const key of ["rpcUrl", "apiUrl"]) {
    const value = net[key];
    if (value === undefined || value === null) fail(`${key} is required (pass --${key.replace("Url", "-url")})`);
    let url;
    try {
      url = new URL(value);
    } catch {
      fail(`${key} is not a URL: ${value}`);
    }
    if (!local && url.protocol !== "https:") fail(`${key} must be https on a public network: ${value}`);
    if (local && url.protocol !== "http:" && url.protocol !== "https:") {
      fail(`${key} must be http(s): ${value}`);
    }
  }
  if (net.explorer !== undefined && net.explorer !== null && !String(net.explorer).startsWith("https://")) {
    fail(`explorer must be https or null: ${net.explorer}`);
  }
  if (net.registryAddress !== undefined && net.registryAddress !== null && !ADDRESS.test(net.registryAddress)) {
    fail(`registryAddress ${net.registryAddress}`);
  }
  if (net.contracts !== undefined && net.contracts !== null) {
    for (const [key, value] of Object.entries(net.contracts)) {
      if (!ADDRESS.test(value)) fail(`contracts.${key} ${value}`);
    }
  }
  if (net.assetSymbol !== undefined && typeof net.assetSymbol !== "string") fail("assetSymbol");
  if (net.assetDecimals !== undefined && (!Number.isSafeInteger(net.assetDecimals) || net.assetDecimals < 0)) {
    fail("assetDecimals");
  }
}

function networkJs(net) {
  const source = net.name ? `networks/${net.name}.json` : "a harness-provided file";
  return `// Network settings for the dashboard. Generated by scripts/dashboard-env.cjs from
// ${source}: edit that file and regenerate, never this one.
export const NETWORK = Object.freeze(${JSON.stringify(net, null, 2)});
`;
}

function headersFile(net) {
  return `/*
  X-Frame-Options: DENY
  X-Content-Type-Options: nosniff
  Referrer-Policy: strict-origin-when-cross-origin
  Permissions-Policy: accelerometer=(), camera=(), geolocation=(), gyroscope=(), magnetometer=(), microphone=(), payment=(), usb=()
  Strict-Transport-Security: max-age=31536000; includeSubDomains; preload
  Content-Security-Policy: default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' https://16ane.com data:; connect-src 'self' ${net.rpcUrl} ${net.apiUrl}; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'

# Branch previews (<branch>-<name>.workers.dev) and the Worker's own workers.dev address
# are copies of the dashboard, not the dashboard: keep them out of search.
https://:version.:subdomain.workers.dev/*
  X-Robots-Tag: noindex
`;
}

function copyStatic(outDir) {
  // Everything except the two generated files ships byte-for-byte.
  const skip = new Set(["_headers", path.join("assets", "network.js")]);
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const src = path.join(dir, entry.name);
      const rel = path.relative(DASHBOARD, src);
      if (skip.has(rel)) continue;
      const dest = path.join(outDir, rel);
      if (entry.isDirectory()) {
        fs.mkdirSync(dest, { recursive: true });
        walk(src);
      } else {
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        fs.copyFileSync(src, dest);
      }
    }
  };
  if (!fs.existsSync(DASHBOARD)) fail("dashboard/ does not exist yet");
  fs.mkdirSync(outDir, { recursive: true });
  walk(DASHBOARD);
}

function main(argv) {
  const args = parseArgs(argv);
  const net = loadSettings(args);
  const outDir = path.resolve(args.outDir);
  copyStatic(outDir);
  fs.mkdirSync(path.join(outDir, "assets"), { recursive: true });
  fs.writeFileSync(path.join(outDir, "assets", "network.js"), networkJs(net));
  fs.writeFileSync(path.join(outDir, "_headers"), headersFile(net));
  console.log(`dashboard-env: wrote ${outDir} (${net.name ?? "custom"}, chain ${net.chainId})`);
}

main(process.argv.slice(2));
