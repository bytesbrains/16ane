// Configuration from ANE_* environment variables. The process holds exactly one
// key: the delegated agentSigner (ANE_AGENT_PRIVATE_KEY). There is deliberately
// no option for an owner root key anywhere in this package: owner funding,
// delegation and revocation happen outside the MCP server (CLI, dashboard),
// before the agent key is handed to this process.

import {
  AgentSession,
  AneClient,
  privateKeyToAddress,
  SecretKey,
  toChecksumAddress,
  type AneContractAddresses,
} from "../../sdk-ts/src/index.ts";
import { LiveBackend } from "./backend.ts";
import type { McpNetwork } from "./backend.ts";

export interface McpConfig {
  rpcUrl: string;
  chainId: number;
  network: McpNetwork;
  registryAddress?: string;
  contracts?: AneContractAddresses;
  vaultAddress: string;
  agentKey: SecretKey;
  sessionAddress: string;
  apiBaseUrl?: string;
  maxPaymentCeiling?: bigint;
  transport: "stdio" | "http";
  httpHost: string;
  httpPort: number;
  httpEndpoint: string;
  allowedOrigins: string[];
  authToken?: string;
}

function requireEnv(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name];
  if (!value) {
    throw new Error(`Missing required environment variable ${name}`);
  }
  return value;
}

function isAddress(value: string): boolean {
  return /^0x[0-9a-fA-F]{40}$/.test(value);
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): McpConfig {
  const rpcUrl = requireEnv(env, "ANE_RPC_URL");
  const chainId = Number(requireEnv(env, "ANE_CHAIN_ID"));
  if (!Number.isInteger(chainId) || chainId <= 0) {
    throw new Error("ANE_CHAIN_ID must be a positive integer");
  }
  const network =
    chainId === 84532 ? "eip155:84532" : chainId === 31337 ? "eip155:31337" : undefined;
  if (!network) {
    throw new Error("ANE_CHAIN_ID must be 84532 (Base Sepolia) or 31337 (local Anvil)");
  }
  const vaultRaw = requireEnv(env, "ANE_VAULT_ADDRESS");
  if (!isAddress(vaultRaw)) {
    throw new Error("ANE_VAULT_ADDRESS must be a 0x address");
  }
  const vaultAddress = toChecksumAddress(vaultRaw);
  const agentKey = new SecretKey(requireEnv(env, "ANE_AGENT_PRIVATE_KEY"));
  const sessionAddress = privateKeyToAddress(agentKey);

  const registryAddress = env["ANE_REGISTRY_ADDRESS"];
  if (registryAddress !== undefined && !isAddress(registryAddress)) {
    throw new Error("ANE_REGISTRY_ADDRESS must be a 0x address");
  }
  const contractVars = [
    "ANE_TOKEN_ADDRESS",
    "ANE_VAULT_FACTORY_ADDRESS",
    "ANE_FAUCET_ADDRESS",
    "ANE_SERVICE_DIRECTORY_ADDRESS",
  ] as const;
  for (const name of contractVars) {
    if (env[name] !== undefined && !isAddress(env[name])) {
      throw new Error(`${name} must be a 0x address`);
    }
  }
  const contracts: AneContractAddresses | undefined =
    env["ANE_TOKEN_ADDRESS"] && env["ANE_VAULT_FACTORY_ADDRESS"] && env["ANE_FAUCET_ADDRESS"] &&
      env["ANE_SERVICE_DIRECTORY_ADDRESS"]
      ? {
          registry: toChecksumAddress(registryAddress ?? "0x0000000000000000000000000000000000000000"),
          aneTestToken: toChecksumAddress(env["ANE_TOKEN_ADDRESS"]),
          aneVaultFactory: toChecksumAddress(env["ANE_VAULT_FACTORY_ADDRESS"]),
          aneFaucet: toChecksumAddress(env["ANE_FAUCET_ADDRESS"]),
          aneServiceDirectory: toChecksumAddress(env["ANE_SERVICE_DIRECTORY_ADDRESS"]),
        }
      : undefined;
  if (!registryAddress && !contracts) {
    throw new Error("Set ANE_REGISTRY_ADDRESS or the four ANE_*_ADDRESS contract addresses");
  }

  const apiBaseUrl = env["ANE_API_BASE_URL"];
  if (apiBaseUrl !== undefined) {
    const protocol = new URL(apiBaseUrl).protocol;
    if (protocol !== "https:" && protocol !== "http:") {
      throw new Error("ANE_API_BASE_URL must use http or https");
    }
  }
  let maxPaymentCeiling: bigint | undefined;
  if (env["ANE_MCP_MAX_PAYMENT"] !== undefined && env["ANE_MCP_MAX_PAYMENT"] !== "") {
    if (!/^(0|[1-9][0-9]*)$/.test(env["ANE_MCP_MAX_PAYMENT"])) {
      throw new Error("ANE_MCP_MAX_PAYMENT must be a base-units integer string");
    }
    maxPaymentCeiling = BigInt(env["ANE_MCP_MAX_PAYMENT"]);
  }

  const transport = env["ANE_MCP_TRANSPORT"] ?? "stdio";
  if (transport !== "stdio" && transport !== "http") {
    throw new Error("ANE_MCP_TRANSPORT must be 'stdio' or 'http'");
  }
  const httpPort = Number(env["ANE_MCP_PORT"] ?? "8786");
  if (!Number.isInteger(httpPort) || httpPort <= 0 || httpPort > 65535) {
    throw new Error("ANE_MCP_PORT must be a valid port number");
  }
  const allowedOrigins = (env["ANE_MCP_ALLOWED_ORIGINS"] ?? "")
    .split(",")
    .map((o) => o.trim())
    .filter((o) => o.length > 0);

  return {
    rpcUrl,
    chainId,
    network,
    registryAddress,
    contracts,
    vaultAddress,
    agentKey,
    sessionAddress,
    apiBaseUrl,
    maxPaymentCeiling,
    transport,
    httpHost: env["ANE_MCP_HOST"] ?? "127.0.0.1",
    httpPort,
    httpEndpoint: env["ANE_MCP_ENDPOINT"] ?? "/mcp",
    allowedOrigins,
    authToken: env["ANE_MCP_AUTH_TOKEN"],
  };
}

export interface LiveWiring {
  client: AneClient;
  session: AgentSession;
  backend: LiveBackend;
  tokenAddress: string;
  directoryAddress: string;
}

/** Builds the SDK client/session/backend triple from config (no I/O yet). */
export async function wireLiveBackend(config: McpConfig): Promise<LiveWiring> {
  const client = new AneClient({
    rpcUrl: config.rpcUrl,
    chainId: config.chainId,
    registryAddress: config.registryAddress,
    contracts: config.contracts,
  });
  const contracts = await client.resolveContracts();
  const session = new AgentSession({
    client,
    vaultAddress: config.vaultAddress,
    sessionKey: config.agentKey,
  });
  const backend = new LiveBackend(client, session, config.agentKey, {
    chainId: config.chainId,
    network: config.network,
    vaultAddress: config.vaultAddress,
    sessionAddress: config.sessionAddress,
    tokenAddress: contracts.aneTestToken,
    directoryAddress: contracts.aneServiceDirectory,
    apiBaseUrl: config.apiBaseUrl,
    maxPaymentCeiling: config.maxPaymentCeiling,
  });
  return {
    client,
    session,
    backend,
    tokenAddress: contracts.aneTestToken,
    directoryAddress: contracts.aneServiceDirectory,
  };
}

/**
 * Startup self-check: the held key must be the vault's delegated agentSigner
 * (not the owner, not a stranger) and the delegation must be active. Fails
 * closed: refusing to serve is safer than serving with the wrong key.
 */
export async function verifyDelegation(client: AneClient, config: McpConfig): Promise<void> {
  let summary;
  try {
    summary = await client.getAccountingSummary(config.vaultAddress);
  } catch (err) {
    // A misconfigured vault (EOA, unrelated contract, wrong chain) fails here
    // with a raw RPC revert; say what to check instead of surfacing it bare.
    throw new Error(
      `Vault delegation check failed for ${config.vaultAddress}: ` +
        `${err instanceof Error ? err.message : String(err)}. ` +
        `Is ANE_VAULT_ADDRESS a delegated AneAgentVault on this chain?`,
    );
  }
  if (summary.agentSigner.toLowerCase() !== config.sessionAddress.toLowerCase()) {
    throw new Error(
      `ANE_AGENT_PRIVATE_KEY does not match the vault's delegated agentSigner ` +
        `(${summary.agentSigner}); refusing to serve. Delegate this key first, and never ` +
        `configure an owner root key here.`,
    );
  }
  if (!summary.active) {
    throw new Error("Vault delegation is not active (revoked or expired); refusing to serve.");
  }
}
