// Starts a complete sandbox on your machine (#20): an Anvil chain with the 16ane contracts, the reference
// sandbox API (faucet, gasless relay, demo endpoints) and a self-hosted x402 facilitator. Nothing here
// touches a public network. Needs Foundry (anvil, forge, cast) on PATH.
//
//   npm run kit:sandbox        # leave it running; Ctrl-C stops everything
import { pathToFileURL } from "node:url";
import { startSandboxStack } from "../../e2e/harness.ts";
import { keccak256Utf8, SecretKey } from "../../packages/sdk-ts/src/index.ts";
import { createFacilitatorServer } from "../../services/facilitator/src/server.ts";
import { addressOf, fundGasIfLocal, SANDBOX_DISCLAIMER, writeNetwork, type KitNetwork } from "./kit.ts";

// A local-only relayer for the facilitator. The sandbox API has its own (the deployer key), and two
// processes must never send from one key: their nonces would collide. Anvil-only test material.
const FACILITATOR_KEY = keccak256Utf8("16ane.hackathon-kit.facilitator.v1");

export async function startLocalSandbox(): Promise<{ net: KitNetwork; stop: () => Promise<void> }> {
  const teardowns: (() => Promise<void>)[] = [];
  // The e2e harness registers teardown on a node:test context; this shim runs it on stop() instead.
  const stack = await startSandboxStack({ after: (fn: () => Promise<void>) => void teardowns.push(fn) } as never);
  const partial: KitNetwork = {
    name: "local",
    rpcUrl: stack.rpcUrl,
    chainId: stack.chainId,
    registryAddress: stack.registryAddress,
    apiUrl: stack.sandbox.url,
  };
  await fundGasIfLocal(partial, addressOf(new SecretKey(FACILITATOR_KEY)));
  const facilitator = await createFacilitatorServer({
    rpcUrl: stack.rpcUrl,
    chainId: stack.chainId,
    registryAddress: stack.registryAddress,
    relayerPrivateKey: FACILITATOR_KEY,
    port: 0,
  });
  const net: KitNetwork = { ...partial, facilitatorUrl: facilitator.url };
  writeNetwork(net);
  return {
    net,
    stop: async () => {
      await facilitator.close();
      for (const fn of teardowns.reverse()) await fn();
    },
  };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const { net, stop } = await startLocalSandbox();
  console.log(`Local sandbox is up. ${SANDBOX_DISCLAIMER}
  chain        ${net.rpcUrl} (chain id ${net.chainId})
  registry     ${net.registryAddress}
  sandbox API  ${net.apiUrl}
  facilitator  ${net.facilitatorUrl}
Saved to examples/hackathon-kit/.kit/network.json. Next, in another terminal: npm run kit:owner -- setup
Press Ctrl-C to stop.`);
  const shutdown = () => void stop().finally(() => process.exit(0));
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
}
