// Checks that e2e/fixtures/erc8004-registries.json still holds the code the public ERC-8004 registries run
// (#22, ADR-0018). The registries are upgradeable proxies owned by a third party: when this fails, they were
// upgraded, and the fixture and the SDK need reviewing against the new implementation before refreshing it.
//   node --experimental-strip-types scripts/check-erc8004-fixture.ts [rpcUrl]
// Exit codes: 0 match, 1 drift found (printed one per line), 2 the RPC could not be read.
import { readFileSync } from "node:fs";
import { keccak256 } from "../packages/sdk-ts/src/index.ts";

// ERC-1967 implementation slot: bytes32(uint256(keccak256("eip1967.proxy.implementation")) - 1).
const IMPLEMENTATION_SLOT = "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc";

async function rpc(url: string, method: string, params: unknown[]): Promise<string> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const body = (await res.json()) as { result?: string; error?: { message: string } };
  if (!res.ok || body.error || typeof body.result !== "string") throw new Error(`${method}: ${body.error?.message ?? res.status}`);
  return body.result;
}

const rpcUrl = process.argv[2] ?? "https://sepolia.base.org";
const fixture = JSON.parse(readFileSync(new URL("../e2e/fixtures/erc8004-registries.json", import.meta.url), "utf8"));
const problems: string[] = [];
try {
  for (const [name, proxy, recorded] of [
    ["IdentityRegistry", fixture.source.identityProxy, fixture.identityRegistry],
    ["ReputationRegistry", fixture.source.reputationProxy, fixture.reputationRegistry],
  ] as const) {
    const impl = "0x" + (await rpc(rpcUrl, "eth_getStorageAt", [proxy, IMPLEMENTATION_SLOT, "latest"])).slice(-40);
    const codehash = keccak256(await rpc(rpcUrl, "eth_getCode", [impl, "latest"]));
    if (codehash !== recorded.codehash) {
      problems.push(`${name} at ${proxy} now runs ${impl} (codehash ${codehash}), not the fixture's ${recorded.codehash}`);
    }
  }
} catch (err) {
  console.error(`Could not read ${rpcUrl}: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(2);
}
if (problems.length) {
  for (const p of problems) console.log(p);
  process.exit(1);
}
console.log(`OK: both ERC-8004 registries on chain ${fixture.source.chainId} run the fixture's v${fixture.source.version} code.`);
