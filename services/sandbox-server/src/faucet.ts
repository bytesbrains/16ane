import type http from "node:http";
import {
  abiWordBytes32,
  type AneClient,
  functionSelector,
  hashClaimAuthorization,
  type KeyValueStore,
  MemoryKeyValueStore,
  randomBytes32Hex,
  recoverAddress,
  SANDBOX_DISCLAIMER,
  type SecretKey,
  type SignedFaucetClaim,
  toChecksumAddress,
} from "../../../packages/sdk-ts/src/index.ts";
import { refuseAboveFeeCeiling, RelayerGasBudgetExceededError, sendBudgetExhausted } from "./gas-budget.ts";
import { clientIp, readRequestBody, sendError, sendJson, sendLoggedError } from "./http.ts";

export interface FaucetConfig {
  claimAmount: bigint;
  cooldownSeconds: number;
}

// Reads the deployed AneFaucet's claim size and cooldown, so the server can never drift from
// the contract (the defaults live in script/DeploySandbox.s.sol and can change with setFaucetConfig).
export async function readFaucetConfig(client: AneClient, faucet: string): Promise<FaucetConfig> {
  const word = async (signature: string) =>
    BigInt((await client.ethCall(faucet, functionSelector(signature))).slice(0, 66));
  return {
    claimAmount: await word("claimAmount()"),
    cooldownSeconds: Number(await word("cooldownSeconds()")),
  };
}

// Mirrors AneFaucet's cooldown, which is keyed on the recipient only (ADR-0006). Checking it
// here turns a claim the contract would revert into a clear 429 instead of a failed transaction.
export class RecipientCooldowns {
  readonly cooldownSeconds: number;
  readonly #store: KeyValueStore;

  constructor(cooldownSeconds: number, store: KeyValueStore = new MemoryKeyValueStore()) {
    this.cooldownSeconds = cooldownSeconds;
    this.#store = store;
  }

  remainingSeconds(recipient: string, nowSec: number): number {
    const last = this.#store.get<number>("faucet.cooldowns", recipient.toLowerCase());
    return last === undefined ? 0 : Math.max(0, last + this.cooldownSeconds - nowSec);
  }

  record(recipient: string, nowSec: number): void {
    this.#store.set("faucet.cooldowns", recipient.toLowerCase(), nowSec);
  }
}

// A signed claim must still be valid when its transaction lands, and needn't be valid for long: the relayer
// sends it straight away (#79).
export const MIN_CLAIM_DEADLINE_SECONDS = 30;
export const MAX_CLAIM_DEADLINE_SECONDS = 3600;

const BYTES32 = /^0x[0-9a-fA-F]{64}$/;
const SIGNATURE = /^0x[0-9a-fA-F]{130}$/;

// Checks a recipient-signed claim the way AneFaucet.relayedClaim will, except for the nonce (on-chain state),
// so a claim the contract would revert is refused before the relayer spends gas. Returns why it is refused.
export function checkSignedClaim(
  chainId: number,
  faucet: string,
  claim: SignedFaucetClaim,
  nowSec: number,
): string | undefined {
  if (!Number.isSafeInteger(claim.deadline) || !BYTES32.test(claim.nonce) || !SIGNATURE.test(claim.signature)) {
    return "authorization needs an integer deadline, a 32-byte nonce and a 65-byte signature";
  }
  if (claim.deadline < nowSec + MIN_CLAIM_DEADLINE_SECONDS || claim.deadline > nowSec + MAX_CLAIM_DEADLINE_SECONDS) {
    return `authorization deadline must be ${MIN_CLAIM_DEADLINE_SECONDS}s to ${MAX_CLAIM_DEADLINE_SECONDS}s from now`;
  }
  const { digest } = hashClaimAuthorization(chainId, faucet, claim);
  let signer: string;
  try {
    signer = recoverAddress(digest, claim.signature);
  } catch {
    return "authorization signature is invalid";
  }
  if (signer.toLowerCase() !== claim.recipient.toLowerCase()) {
    return "authorization is not signed by the recipient";
  }
  return undefined;
}

export const TURNSTILE_SITEVERIFY_URL = "https://challenges.cloudflare.com/turnstile/v0/siteverify";

// Cloudflare Turnstile for the anonymous web faucet (ADR-0006): the browser's token is checked server-side
// with siteverify. Tokens are single-use and expire after 300 seconds; Cloudflare enforces both.
export class TurnstileVerifier {
  readonly #secretKey: string;
  readonly #expectedHostname?: string;
  readonly #siteverifyUrl: string;

  constructor(secretKey: string, options: { expectedHostname?: string; siteverifyUrl?: string } = {}) {
    this.#secretKey = secretKey;
    this.#expectedHostname = options.expectedHostname;
    this.#siteverifyUrl = options.siteverifyUrl ?? TURNSTILE_SITEVERIFY_URL;
  }

  /** Returns why the token is refused, or undefined when it passes. Throws if siteverify can't be reached. */
  async check(token: string, remoteIp: string): Promise<string | undefined> {
    const res = await fetch(this.#siteverifyUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ secret: this.#secretKey, response: token, remoteip: remoteIp }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) throw new Error(`Turnstile siteverify answered HTTP ${res.status}`);
    const outcome = (await res.json()) as { success?: boolean; hostname?: string; "error-codes"?: string[] };
    if (outcome.success !== true) {
      return `Turnstile check failed (${(outcome["error-codes"] ?? []).join(", ") || "no reason given"})`;
    }
    if (this.#expectedHostname && outcome.hostname !== this.#expectedHostname) {
      return "Turnstile token was issued for another site";
    }
    return undefined;
  }
}

export interface FaucetContext {
  client: AneClient;
  relayerKey: SecretKey;
  store: KeyValueStore;
  chainId: number;
  faucetAddress: string;
  faucetConfig: FaucetConfig;
  cooldowns: RecipientCooldowns;
  /** Unset: the web (Turnstile) path is off. */
  turnstile?: TurnstileVerifier;
  /** Accept claims with no proof at all; only for local or private servers (#79). */
  openClaims: boolean;
  trustProxy: boolean;
  clientIpHeader?: string;
  maxBodyBytes: number;
  /** Recipients with a claim being sent, so a concurrent duplicate is refused instead of reverting on-chain. */
  inFlight: Set<string>;
  /** The relayer's gas-price ceiling (ADR-0006); unset: none. */
  maxFeeWei?: bigint;
}

export interface ClaimStatusRecord {
  claimId: string;
  recipient: string;
  amount: string;
  symbol: "tANE";
  txHash: string;
  blockNumber: number;
  createdAt: string;
  disclaimer: string;
}

interface ClaimRequestBody {
  recipient?: string;
  amount?: string;
  authorization?: { deadline?: number; nonce?: string; signature?: string };
  turnstileToken?: string;
}

// POST /v1/faucet/claims. Each claim carries a proof (#79): an `authorization` signed by the recipient (agents
// and the CLI; relayed with relayedClaim) or a `turnstileToken` (the web faucet). Every check that can refuse
// a claim runs before the relayer sends anything, so a refused claim costs no gas.
export async function handleFaucetClaim(
  ctx: FaucetContext,
  req: http.IncomingMessage,
  res: http.ServerResponse,
): Promise<void> {
  const rawBody = await readRequestBody(req, ctx.maxBodyBytes);
  const body = rawBody ? (JSON.parse(rawBody) as ClaimRequestBody) : {};
  if (!body.recipient) {
    sendError(res, 400, "ANE-E-1001", "Missing recipient address", false);
    return;
  }
  const recipient = toChecksumAddress(body.recipient);
  // The contract always mints its fixed claimAmount; a smaller requested amount is accepted but ignored.
  const amountOk = body.amount == null || (typeof body.amount === "string" && /^\d+$/.test(body.amount));
  const amount = amountOk && body.amount != null ? BigInt(body.amount) : ctx.faucetConfig.claimAmount;
  if (!amountOk || amount <= 0n || amount > ctx.faucetConfig.claimAmount) {
    sendError(
      res,
      400,
      "ANE-E-1002",
      `Requested amount exceeds the faucet claim (${ctx.faucetConfig.claimAmount.toString()} wei)`,
      false,
    );
    return;
  }

  const nowSec = Math.floor(Date.now() / 1000);
  let signed: SignedFaucetClaim | undefined;
  let turnstileToken: string | undefined;
  if (body.authorization) {
    const { deadline, nonce, signature } = body.authorization;
    signed = {
      recipient,
      campaignId: "0x" + "00".repeat(32),
      deadline: deadline as number,
      nonce: nonce as string,
      signature: signature as string,
    };
    const refusal = checkSignedClaim(ctx.chainId, ctx.faucetAddress, signed, nowSec);
    if (refusal) {
      sendError(res, 403, "ANE-E-1008", `Faucet claim refused: ${refusal}`, false);
      return;
    }
  } else if (typeof body.turnstileToken === "string" && body.turnstileToken && ctx.turnstile) {
    if (body.turnstileToken.length > 2048) {
      sendError(res, 403, "ANE-E-1008", "Faucet claim refused: Turnstile token is malformed", false);
      return;
    }
    turnstileToken = body.turnstileToken;
  } else if (!ctx.openClaims) {
    const web = ctx.turnstile ? " or a `turnstileToken` from the web faucet" : "";
    sendError(
      res,
      401,
      "ANE-E-1007",
      `Faucet claims need a proof: an \`authorization\` signed by the recipient (AneClient.signFaucetClaim)${web}`,
      false,
    );
    return;
  }

  // Before any check that consumes something (a Turnstile token, an RPC call), so a retry is cheap.
  const waitSeconds = ctx.cooldowns.remainingSeconds(recipient, nowSec);
  if (waitSeconds > 0) {
    sendError(res, 429, "ANE-E-1003", `Faucet cooldown active for this recipient; retry in ${waitSeconds}s`, true);
    return;
  }
  const key = recipient.toLowerCase();
  if (ctx.inFlight.has(key)) {
    sendError(res, 409, "ANE-E-1009", "A faucet claim for this recipient is already in progress", true);
    return;
  }
  ctx.inFlight.add(key);
  try {
    if (signed) {
      // Anything but one well-formed word (a revert, an empty or garbled reply) is a failure, never "unused".
      let used: string;
      try {
        used = await ctx.client.ethCall(
          ctx.faucetAddress,
          functionSelector("relayedNonceUsed(bytes32)") + abiWordBytes32(signed.nonce),
        );
        if (typeof used !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(used)) {
          throw new Error(`relayedNonceUsed returned ${JSON.stringify(used)}`);
        }
      } catch (err) {
        sendLoggedError(res, 502, "ANE-E-1004", "Faucet could not check the claim on-chain; try again later", true, err);
        return;
      }
      if (BigInt(used) !== 0n) {
        sendError(res, 403, "ANE-E-1008", "Faucet claim refused: authorization nonce was already used", false);
        return;
      }
    }
    if (turnstileToken) {
      let refusal: string | undefined;
      try {
        refusal = await ctx.turnstile!.check(turnstileToken, clientIp(req, ctx.trustProxy, ctx.clientIpHeader));
      } catch (err) {
        sendLoggedError(res, 503, "ANE-E-1010", "Turnstile verification is unavailable; try again later", true, err);
        return;
      }
      if (refusal) {
        sendError(res, 403, "ANE-E-1008", `Faucet claim refused: ${refusal}`, false);
        return;
      }
    }

    const selfServe = "claim directly from the AneFaucet contract (claim(address)) with your own gas";
    if (await refuseAboveFeeCeiling((m, p) => ctx.client.rpcCall(m, p), ctx.maxFeeWei, res, selfServe)) return;
    try {
      const settled = signed
        ? await ctx.client.executeRelayedFaucetClaimOnChain(ctx.relayerKey, signed)
        : await ctx.client.executeFaucetClaimOnChain(ctx.relayerKey, recipient);
      ctx.cooldowns.record(recipient, nowSec);
      const claimId = `claim_${randomBytes32Hex().slice(2, 26)}`;
      const record: ClaimStatusRecord = {
        claimId,
        recipient,
        amount: ctx.faucetConfig.claimAmount.toString(),
        symbol: "tANE",
        txHash: settled.txHash,
        blockNumber: settled.blockNumber,
        createdAt: new Date().toISOString(),
        disclaimer: SANDBOX_DISCLAIMER,
      };
      ctx.store.set("faucet.claims", claimId, record);
      sendJson(res, 201, record);
    } catch (err) {
      if (err instanceof RelayerGasBudgetExceededError) {
        sendBudgetExhausted(res, err, selfServe);
        return;
      }
      sendLoggedError(res, 502, "ANE-E-1004", "Faucet claim could not be completed on-chain; try again later", true, err);
    }
  } finally {
    ctx.inFlight.delete(key);
  }
}
