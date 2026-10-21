import type http from "node:http";
import {
  type AneClient,
  type AneContractAddresses,
  createVaultCalldata,
  functionSelector,
  abiWordAddress,
  hashRevoke,
  hashSetPolicy,
  hashTransferWithAuthorization,
  hashVaultCreation,
  recoverAddress,
  relayCreateVault,
  relayRevoke,
  relaySetPolicy,
  relayTransfer,
  revokeCalldata,
  SANDBOX_DISCLAIMER,
  type SecretKey,
  setPolicyCalldata,
  type SignedPolicy,
  type SignedRevoke,
  type SignedTransfer,
  type SignedVaultCreation,
  toChecksumAddress,
  transferCalldata,
} from "../../../packages/sdk-ts/src/index.ts";
import { refuseAboveFeeCeiling, RelayerGasBudgetExceededError, sendBudgetExhausted } from "./gas-budget.ts";
import { readRequestBody, redactUrls, sendError, sendJson, sendLoggedError } from "./http.ts";

// POST /v1/relay (#77, ADR-0006): the relayer submits an owner-signed action and pays its gas, so a tANE holder
// never needs ETH. Only four actions on three kinds of target are relayed: a tANE transfer (EIP-3009; also how a
// vault is funded), a vault creation, a vault policy and a revocation. Every check that can refuse a request
// runs before anything is sent, so a refused request costs no gas: the shape, the deadline, the signer
// (recovered locally), the target (the tANE token, the factory, or a vault the factory registered), the fee
// ceiling, and finally a simulation of the exact call from the relayer's address. The deadline is checked again
// immediately before send, so a slow prepare/simulate cannot burn gas on an already-expired signature. Simulation
// is best-effort at the node's latest state (no block override, no gas cap): a mining-block state change can still
// revert on-chain, which surfaces as ANE-E-1206 after the send attempt. The only limit is cost: the relayer's
// daily gas budget (#76); there are no per-agent counts (#61).

export const MIN_DEADLINE_SECONDS = 30;
export const MAX_DEADLINE_SECONDS = 3600;

export interface RelayContext {
  client: AneClient;
  relayerKey: SecretKey;
  relayerAddress: string;
  chainId: number;
  contracts: AneContractAddresses;
  /** Refuse to send while the network's gas price is above this (ADR-0006). Unset: no ceiling. */
  maxFeeWei?: bigint;
  maxBodyBytes: number;
  /** Signatures being sent, so a concurrent duplicate is refused instead of reverting on-chain. */
  inFlight: Set<string>;
}

class Refusal extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}
const bad = (message: string) => new Refusal(400, "ANE-E-1201", message);
const denied = (message: string) => new Refusal(403, "ANE-E-1202", message);

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const BYTES32 = /^0x[0-9a-fA-F]{64}$/;
const SIGNATURE = /^0x[0-9a-fA-F]{130}$/;
const UINT = /^\d{1,78}$/;

const address = (v: unknown, name: string) => {
  if (typeof v !== "string" || !ADDRESS.test(v)) throw bad(`${name} must be an address`);
  return toChecksumAddress(v);
};
const bytes32 = (v: unknown, name: string) => {
  if (typeof v !== "string" || !BYTES32.test(v)) throw bad(`${name} must be 32 bytes of hex`);
  return v;
};
const uint = (v: unknown, name: string) => {
  const s = typeof v === "number" && Number.isSafeInteger(v) ? String(v) : v;
  if (typeof s !== "string" || !UINT.test(s)) throw bad(`${name} must be a whole number`);
  return BigInt(s);
};
const smallUint = (v: unknown, name: string) => {
  const n = uint(v, name);
  if (n > BigInt(Number.MAX_SAFE_INTEGER)) throw bad(`${name} is too large`);
  return Number(n);
};
const signature = (v: unknown) => {
  if (typeof v !== "string" || !SIGNATURE.test(v)) throw bad("signature must be 65 bytes of hex");
  return v;
};
const signedBy = (digest: string, sig: string, expected: string, what: string) => {
  let signer: string;
  try {
    signer = recoverAddress(digest, sig);
  } catch {
    throw denied(`${what}: the signature is invalid`);
  }
  if (signer.toLowerCase() !== expected.toLowerCase()) throw denied(`${what}: not signed by ${expected}`);
};
const deadlineOk = (deadline: number, nowSec: number, what: string) => {
  if (deadline < nowSec + MIN_DEADLINE_SECONDS || deadline > nowSec + MAX_DEADLINE_SECONDS) {
    throw denied(`${what}: the deadline must be ${MIN_DEADLINE_SECONDS}s to ${MAX_DEADLINE_SECONDS}s from now`);
  }
};

type Prepared = {
  to: string;
  data: string;
  /** Unix seconds when the signature stops being valid (validBefore / deadline). */
  expiresAtSec: number;
  what: string;
  send: (nowSec: number) => Promise<{ txHash: string; blockNumber: number; vaultAddress?: string }>;
};

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

async function vaultOwner(ctx: RelayContext, vault: string): Promise<string> {
  const registered = await ctx.client.ethCall(
    ctx.contracts.aneVaultFactory,
    functionSelector("isRegisteredVault(address)") + abiWordAddress(vault),
  );
  if (BigInt(registered.slice(0, 66)) === 0n) throw denied(`${vault} is not a vault created by the 16ane factory`);
  const owner = (await ctx.client.getAccountingSummary(vault)).owner;
  // Runtime boundary: a registered-but-uninitialized (or corrupt) summary must not be compared as a signer.
  if (owner.toLowerCase() === ZERO_ADDRESS) throw denied(`${vault} has no owner`);
  return owner;
}

// Parses and checks one action, without sending or simulating it.
async function prepare(ctx: RelayContext, body: Record<string, unknown>, nowSec: number): Promise<Prepared> {
  const { client, relayerKey } = ctx;
  switch (body.action) {
    case "transfer": {
      const t: SignedTransfer = {
        from: address(body.from, "from"),
        to: address(body.to, "to"),
        value: uint(body.value, "value"),
        validAfter: smallUint(body.validAfter ?? 0, "validAfter"),
        validBefore: smallUint(body.validBefore, "validBefore"),
        nonce: bytes32(body.nonce, "nonce"),
        signature: signature(body.signature),
      };
      if (Number(t.validAfter) > nowSec) throw denied("transfer: not valid yet (validAfter)");
      deadlineOk(Number(t.validBefore), nowSec, "transfer");
      const { digest } = hashTransferWithAuthorization(ctx.chainId, ctx.contracts.aneTestToken, t);
      signedBy(digest, t.signature, t.from, "transfer");
      return {
        to: ctx.contracts.aneTestToken,
        data: transferCalldata(t),
        expiresAtSec: Number(t.validBefore),
        what: "transfer",
        send: () => relayTransfer(client, relayerKey, t),
      };
    }
    case "createVault": {
      const c: SignedVaultCreation = {
        owner: address(body.owner, "owner"),
        salt: bytes32(body.salt, "salt"),
        deadline: smallUint(body.deadline, "deadline"),
        signature: signature(body.signature),
      };
      deadlineOk(c.deadline, nowSec, "createVault");
      signedBy(hashVaultCreation(ctx.chainId, ctx.contracts.aneVaultFactory, c.owner, c.salt, c.deadline), c.signature, c.owner, "createVault");
      return {
        to: ctx.contracts.aneVaultFactory,
        data: createVaultCalldata(c.owner, c.salt),
        expiresAtSec: c.deadline,
        what: "createVault",
        send: (atSec) => relayCreateVault(client, relayerKey, c, atSec),
      };
    }
    case "setPolicy": {
      const p = (body.policy ?? {}) as Record<string, unknown>;
      const mode = smallUint(p.budgetMode, "policy.budgetMode");
      if (mode > 1) throw bad("policy.budgetMode must be 0 (FIXED) or 1 (REVOLVING)");
      const s: SignedPolicy = {
        vault: address(body.vault, "vault"),
        policy: {
          agentSigner: address(p.agentSigner, "policy.agentSigner"),
          maxTotalSpend: uint(p.maxTotalSpend, "policy.maxTotalSpend"),
          maxPerTx: uint(p.maxPerTx, "policy.maxPerTx"),
          dailyLimit: uint(p.dailyLimit, "policy.dailyLimit"),
          expiry: smallUint(p.expiry, "policy.expiry"),
          budgetMode: mode,
          revolvingTreasuryCeiling: uint(p.revolvingTreasuryCeiling, "policy.revolvingTreasuryCeiling"),
        },
        expectedPolicyVersion: smallUint(body.expectedPolicyVersion, "expectedPolicyVersion"),
        deadline: smallUint(body.deadline, "deadline"),
        signature: signature(body.signature),
      };
      deadlineOk(s.deadline, nowSec, "setPolicy");
      const owner = await vaultOwner(ctx, s.vault);
      signedBy(hashSetPolicy(ctx.chainId, s.vault, s.policy, s.expectedPolicyVersion, s.deadline), s.signature, owner, "setPolicy");
      return {
        to: s.vault,
        data: setPolicyCalldata(s),
        expiresAtSec: s.deadline,
        what: "setPolicy",
        send: () => relaySetPolicy(client, relayerKey, s),
      };
    }
    case "revoke": {
      const r: SignedRevoke = {
        vault: address(body.vault, "vault"),
        expectedPolicyVersion: smallUint(body.expectedPolicyVersion, "expectedPolicyVersion"),
        deadline: smallUint(body.deadline, "deadline"),
        signature: signature(body.signature),
      };
      deadlineOk(r.deadline, nowSec, "revoke");
      const owner = await vaultOwner(ctx, r.vault);
      signedBy(hashRevoke(ctx.chainId, r.vault, r.expectedPolicyVersion, r.deadline), r.signature, owner, "revoke");
      return {
        to: r.vault,
        data: revokeCalldata(r),
        expiresAtSec: r.deadline,
        what: "revoke",
        send: () => relayRevoke(client, relayerKey, r),
      };
    }
    default:
      throw bad("action must be one of transfer, createVault, setPolicy, revoke");
  }
}

export async function handleRelay(ctx: RelayContext, req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const rawBody = await readRequestBody(req, ctx.maxBodyBytes);
  const body = rawBody ? (JSON.parse(rawBody) as unknown) : {};
  const action = typeof body === "object" && body !== null ? (body as Record<string, unknown>) : {};
  const nowSec = Math.floor(Date.now() / 1000);

  let prepared: Prepared;
  try {
    prepared = await prepare(ctx, action, nowSec);
  } catch (err) {
    if (err instanceof Refusal) return sendError(res, err.status, err.code, err.message, false);
    throw err;
  }

  const key = String(action.signature).toLowerCase();
  if (ctx.inFlight.has(key)) {
    return sendError(res, 409, "ANE-E-1203", "This signed action is already being relayed", true);
  }
  ctx.inFlight.add(key);
  try {
    if (await refuseAboveFeeCeiling((m, p) => ctx.client.rpcCall(m, p), ctx.maxFeeWei, res, "submit it yourself with your own gas")) {
      return;
    }
    try {
      await ctx.client.simulateCall(ctx.relayerAddress, prepared.to, prepared.data);
    } catch (err) {
      const why = redactUrls(err instanceof Error ? err.message : String(err)).slice(0, 300);
      return sendError(res, 422, "ANE-E-1204", `The action would revert, so it was not sent: ${why}`, false);
    }
    // Re-check after prepare/simulate so a deadline that slid past during RPC work is refused without gas spend.
    const sendAtSec = Math.floor(Date.now() / 1000);
    if (prepared.expiresAtSec <= sendAtSec) {
      return sendError(res, 403, "ANE-E-1202", `${prepared.what}: the deadline has passed`, false);
    }
    try {
      const sent = await prepared.send(sendAtSec);
      sendJson(res, 201, { action: action.action, ...sent, sponsored: true, disclaimer: SANDBOX_DISCLAIMER });
    } catch (err) {
      if (err instanceof RelayerGasBudgetExceededError) {
        return sendBudgetExhausted(res, err, "submit it yourself with your own gas");
      }
      sendLoggedError(res, 502, "ANE-E-1206", "The relayed transaction could not be completed; try again later", true, err);
    }
  } finally {
    ctx.inFlight.delete(key);
  }
}
