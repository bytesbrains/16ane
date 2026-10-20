#!/usr/bin/env -S node --experimental-strip-types

import fs from "node:fs";
import path from "node:path";
import {
  AneClient,
  AgentSession,
  OwnerWallet,
  generateKeypair,
  SANDBOX_DISCLAIMER,
  SecretKey,
} from "../../sdk-ts/src/index.ts";

function parseFlags(args) {
  const out = {};
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const next = args[i + 1];
      if (!next || next.startsWith("--")) {
        out[key] = true;
      } else {
        out[key] = next;
        i += 1;
      }
    }
  }
  return out;
}

function getClient(flags) {
  const rpcUrl = flags["rpc-url"] ?? process.env.ANE_RPC_URL ?? "http://127.0.0.1:8545";
  const chainId = Number(flags["chain-id"] ?? process.env.ANE_CHAIN_ID ?? "84532");
  const registryAddress = flags["registry"] ?? process.env.ANE_REGISTRY_ADDRESS ?? undefined;
  return new AneClient({ rpcUrl, chainId, registryAddress });
}

async function main() {
  const argv = process.argv.slice(2);
  const [group, subcommand, ...rest] = argv;
  const flags = parseFlags(rest);

  if (!group || group === "--help" || group === "-h" || group === "help") {
    console.log(
      JSON.stringify(
        {
          cli: "ane",
          version: "0.1.0",
          commands: [
            "ane network list",
            "ane wallet create",
            "ane wallet fund --test --api-url <url>   (signs with ANE_OWNER_PRIVATE_KEY; funds its address)",
            "ane wallet delegate --vault <address> --session <address> --cap <wei> --per-tx <wei>",
            "ane wallet revoke --vault <address> --session <address> [--sweep-to <address>]",
            "ane wallet withdraw --vault <address> --to <address> --amount <wei>",
            "ane pay --url <url> --vault <address> [--body <json>] [--max-payment <wei>]",
            "ane service publish --manifest <file> --api-url <url>",
            "ane receipt verify --tx <hash> --payee <address> --amount <wei>",
          ],
          disclaimer: SANDBOX_DISCLAIMER,
        },
        null,
        2,
      ),
    );
    return;
  }

  if (group === "network" && subcommand === "list") {
    const networksDir = path.resolve(import.meta.dirname, "../../../networks");
    const files = fs.readdirSync(networksDir).filter((f) => f.endsWith(".json"));
    const networks = files.map((f) =>
      JSON.parse(fs.readFileSync(path.join(networksDir, f), "utf8")),
    );
    console.log(JSON.stringify({ networks, disclaimer: SANDBOX_DISCLAIMER }, null, 2));
    return;
  }

  if (group === "wallet" && subcommand === "create") {
    const owner = generateKeypair();
    const session = generateKeypair();
    console.log(
      JSON.stringify(
        {
          ownerAddress: owner.address,
          sessionAddress: session.address,
          keyStorageNotice:
            "Private keys are generated in memory and redacted in standard output (REQ-003, ADR-0010). Export keys to your local environment variables ANE_OWNER_PRIVATE_KEY and ANE_SESSION_PRIVATE_KEY.",
          disclaimer: SANDBOX_DISCLAIMER,
        },
        null,
        2,
      ),
    );
    return;
  }

  if (group === "wallet" && subcommand === "fund") {
    if (!flags["test"]) {
      throw new Error("Only simulated sandbox funding (--test) is supported in Phase 1 (REQ-012)");
    }
    const apiUrl = flags["api-url"] ?? process.env.ANE_API_URL ?? "http://127.0.0.1:8787";
    const recipient = flags["recipient"];
    const ownerKey = process.env.ANE_OWNER_PRIVATE_KEY;
    let claim = { recipient, amount: flags["amount"] };
    if (ownerKey) {
      // The faucet wants a proof (#79): the recipient signs a claim the server relays, so it pays no gas.
      // The faucet's address and chain come from the server itself.
      const { networks } = await (await fetch(`${apiUrl}/v1/networks`)).json();
      const client = new AneClient({ rpcUrl: apiUrl, chainId: networks[0].chainId, contracts: networks[0].contracts });
      const signed = await client.signFaucetClaim(new SecretKey(ownerKey));
      if (recipient && recipient.toLowerCase() !== signed.recipient.toLowerCase()) {
        throw new Error("--recipient must be ANE_OWNER_PRIVATE_KEY's address: a signed claim funds its signer");
      }
      const { deadline, nonce, signature } = signed;
      claim = { recipient: signed.recipient, amount: flags["amount"], authorization: { deadline, nonce, signature } };
    } else if (!recipient) {
      throw new Error("Set ANE_OWNER_PRIVATE_KEY to sign the claim (or pass --recipient to a server with open claims)");
    }
    const res = await fetch(`${apiUrl}/v1/faucet/claims`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(claim),
    });
    const body = await res.json();
    if (!res.ok) {
      throw new Error(`Faucet request failed (${res.status}): ${JSON.stringify(body)}`);
    }
    console.log(JSON.stringify(body, null, 2));
    return;
  }

  if (group === "wallet" && subcommand === "delegate") {
    const ownerKey = process.env.ANE_OWNER_PRIVATE_KEY;
    if (!ownerKey) {
      throw new Error("ANE_OWNER_PRIVATE_KEY environment variable is required");
    }
    const client = getClient(flags);
    const owner = new OwnerWallet(client, new SecretKey(ownerKey));
    const vaultAddress =
      flags["vault"] ?? (await owner.ensureVaultDeployed(0n)).vaultAddress;
    const sessionAddress = flags["session"];
    const allowanceCap = flags["cap"] ?? (320n * 10n ** 18n).toString();
    const perTxLimit = flags["per-tx"] ?? (64n * 10n ** 18n).toString();
    const expiry = Number(flags["expiry"] ?? Math.floor(Date.now() / 1000) + 86400);
    const mode = flags["mode"] ?? "FIXED";
    const res = await owner.delegateSession(vaultAddress, sessionAddress, {
      mode,
      allowanceCap,
      perTxLimit,
      expiry,
    });
    console.log(
      JSON.stringify(
        {
          vaultAddress,
          sessionAddress,
          mode,
          allowanceCap,
          perTxLimit,
          expiry,
          txHash: res.txHash,
          disclaimer: SANDBOX_DISCLAIMER,
        },
        null,
        2,
      ),
    );
    return;
  }

  if (group === "wallet" && subcommand === "revoke") {
    const ownerKey = process.env.ANE_OWNER_PRIVATE_KEY;
    if (!ownerKey) {
      throw new Error("ANE_OWNER_PRIVATE_KEY environment variable is required");
    }
    const client = getClient(flags);
    const owner = new OwnerWallet(client, new SecretKey(ownerKey));
    const vaultAddress = flags["vault"];
    const sessionAddress = flags["session"];
    const sweepTo = flags["sweep-to"];
    const res = sweepTo
      ? await owner.revokeAndSweep(vaultAddress, sessionAddress, sweepTo)
      : await owner.revokeSession(vaultAddress);
    console.log(
      JSON.stringify(
        {
          vaultAddress,
          sessionAddress,
          sweptTo: sweepTo ?? null,
          txHash: res.txHash,
          disclaimer: SANDBOX_DISCLAIMER,
        },
        null,
        2,
      ),
    );
    return;
  }

  if (group === "wallet" && subcommand === "withdraw") {
    const ownerKey = process.env.ANE_OWNER_PRIVATE_KEY;
    if (!ownerKey) {
      throw new Error("ANE_OWNER_PRIVATE_KEY environment variable is required");
    }
    const client = getClient(flags);
    const owner = new OwnerWallet(client, new SecretKey(ownerKey));
    const vaultAddress = flags["vault"];
    const to = flags["to"] ?? owner.address;
    const amount = flags["amount"];
    const res = await owner.withdrawPrincipal(vaultAddress, to, amount);
    console.log(
      JSON.stringify(
        {
          vaultAddress,
          to,
          amount,
          txHash: res.txHash,
          disclaimer: SANDBOX_DISCLAIMER,
        },
        null,
        2,
      ),
    );
    return;
  }

  if (group === "pay") {
    const sessionKey = process.env.ANE_SESSION_PRIVATE_KEY;
    if (!sessionKey) {
      throw new Error("ANE_SESSION_PRIVATE_KEY environment variable is required");
    }
    const url = flags["url"] ?? subcommand;
    const vaultAddress = flags["vault"];
    if (!url || !vaultAddress) {
      throw new Error("Usage: ane pay --url <url> --vault <address>");
    }
    const client = getClient(flags);
    const session = new AgentSession({
      client,
      vaultAddress,
      sessionKey: new SecretKey(sessionKey),
    });
    const result = await session.purchase(url, {
      method: flags["method"] ?? "POST",
      body: flags["body"] ?? '{"text":"16ane CLI test payment"}',
      maxPayment: flags["max-payment"],
      verifyManifest: Boolean(flags["verify-manifest"]),
      verifyReceiptOnChain: true,
    });
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  if (group === "service" && subcommand === "publish") {
    const manifestPath = flags["manifest"];
    const apiUrl = flags["api-url"] ?? process.env.ANE_API_URL ?? "http://127.0.0.1:8787";
    const manifestJson = fs.readFileSync(manifestPath, "utf8");
    const res = await fetch(`${apiUrl}/v1/services`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: manifestJson,
    });
    console.log(JSON.stringify(await res.json(), null, 2));
    return;
  }

  if (group === "receipt" && subcommand === "verify") {
    const client = getClient(flags);
    const txHash = flags["tx"];
    const expectedPayee = flags["payee"];
    const expectedAmount = flags["amount"];
    const expectedVault = flags["vault"];
    const check = await client.verifySettlementOnChain({
      txHash,
      expectedPayee,
      expectedAmount,
      expectedVault,
    });
    console.log(JSON.stringify({ ...check, disclaimer: SANDBOX_DISCLAIMER }, null, 2));
    if (!check.verified) {
      process.exitCode = 1;
    }
    return;
  }

  throw new Error(`Unknown command: ${argv.join(" ")}`);
}

main().catch((err) => {
  console.error(
    JSON.stringify({
      error: err instanceof Error ? err.message : String(err),
      disclaimer: SANDBOX_DISCLAIMER,
    }),
  );
  process.exit(1);
});
