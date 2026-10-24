// The seven 16ane MCP tools (REQ-102): constrained discovery, quoting, balance
// inspection and bounded purchasing. Wallet-side policy is enforced here AND by
// the vault contract on-chain; prompt text is never enforcement.
//
// Trust boundaries: service manifests, quotes and purchase results originate
// from merchants and are untrusted. They are fenced as such in text output and
// flagged in structured output. The agentSigner key lives in the backend and is
// never serialized into any result, error or log.


import { SANDBOX_DISCLAIMER } from "./backend.ts";
import type { McpBackend } from "./backend.ts";
import type { ServiceManifestPayload } from "../../sdk-ts/src/index.ts";
import type { ToolAdapter, ToolDefinition, ToolResult } from "./protocol.ts";
import { listToolDefinitions } from "./tool-definitions.ts";
import {
  ToolError,
  errResult,
  isRecord,
  okResult,
  optionalBoolean,
  optionalString,
  parseAmount,
  parseManifestEndpoints,
  parseMethod,
  requireArgs,
  requireHttpUrl,
  requireString,
  truncate,
  untrusted,
} from "./tool-args.ts";

export { listToolDefinitions } from "./tool-definitions.ts";
export {
  ToolError,
  UNTRUSTED_BEGIN,
  UNTRUSTED_END,
  parseAmount,
  parseManifestEndpoints,
  truncate,
  untrusted,
} from "./tool-args.ts";

export class SixteenAneAdapter implements ToolAdapter {
  readonly #backend: McpBackend;

  constructor(backend: McpBackend) {
    this.#backend = backend;
  }

  listTools(): ToolDefinition[] {
    return listToolDefinitions();
  }

  async callTool(name: string, args: unknown): Promise<ToolResult> {
    try {
      switch (name) {
        case "list_services":
          return await this.#listServices(args);
        case "get_quote":
          return await this.#getQuote(args);
        case "wallet_balance":
          return await this.#walletBalance(args);
        case "payment_status":
          return await this.#paymentStatus(args);
        case "purchase_service":
          return await this.#purchaseService(args);
        case "publish_service":
          return await this.#publishService(args);
        case "request_refund":
          return await this.#requestRefund(args);
        default:
          return errResult(`Unknown tool '${name}'`);
      }
    } catch (err) {
      // Tool failures (bad args, merchant errors, RPC outages) are tool results
      // with isError, not protocol failures: the model needs to see them.
      return errResult(err instanceof Error ? err.message : String(err));
    }
  }

  async #listServices(args: unknown): Promise<ToolResult> {
    const a = requireArgs(args);
    const provider = optionalString(a, "provider")?.toLowerCase();
    const verify = optionalBoolean(a, "verify_signatures", true);
    const { services, source } = await this.#backend.listServices();
    const rows = services
      .filter(
        (s) =>
          provider === undefined ||
          s.signer?.toLowerCase().includes(provider) ||
          s.name.toLowerCase().includes(provider) ||
          s.serviceId.toLowerCase().includes(provider),
      )
      .map((s) => {
        const check = verify ? this.#backend.verifyManifest(s) : null;
        return {
          service_id: s.serviceId,
          name: s.name,
          description: s.description ?? "",
          version: s.version,
          pay_to: s.payTo,
          signature_valid: check ? check.valid : null,
          signer: check?.signer ?? s.signer ?? null,
          signature_reason: check && !check.valid ? check.reason : null,
          endpoints: s.endpoints.map((e) => ({
            id: e.id,
            method: e.method,
            path: e.path,
            price_amount: e.priceAmount,
            scheme: e.scheme,
          })),
        };
      });
    const lines = rows.map(
      (r) =>
        `- ${r.service_id} (${r.name}) signature_valid=${r.signature_valid ?? "unchecked"} pay_to=${r.pay_to}\n` +
        `  ${r.endpoints.map((e) => `${e.method} ${e.path} = ${e.price_amount} tANE/base`).join("; ")}`,
    );
    const text =
      `Services from ${source} (${rows.length} shown):\n` +
      untrusted(lines.length > 0 ? truncate(lines.join("\n")) : "(none match)") +
      `\n${SANDBOX_DISCLAIMER}`;
    return okResult(text, { services: rows, source, untrusted: true, disclaimer: SANDBOX_DISCLAIMER });
  }

  async #getQuote(args: unknown): Promise<ToolResult> {
    const a = requireArgs(args);
    const url = requireHttpUrl(requireString(a, "url"), "url");
    const body = optionalString(a, "body");
    const method = parseMethod(a["method"], body === undefined ? "GET" : "POST");
    const verifyManifest = optionalBoolean(a, "verify_manifest", true);
    const cfg = this.#backend.config;
    const probe = await this.#backend.probeUrl(url, {
      method,
      headers: {
        accept: "application/json",
        "x-agent-vault": cfg.vaultAddress,
        "x-agent-session": cfg.sessionAddress,
      },
      body,
    });
    const paymentRequiredB64 = probe.headers["payment-required"];
    if (probe.status !== 402 || !paymentRequiredB64) {
      if (probe.status >= 200 && probe.status < 300) {
        const text =
          `No payment required (HTTP ${probe.status}). The endpoint answered without a 402 quote.`;
        return okResult(text, {
          payment_required: false,
          status: probe.status,
          untrusted: false,
          disclaimer: SANDBOX_DISCLAIMER,
        });
      }
      throw new ToolError(
        `Quote probe failed: HTTP ${probe.status} with no usable 402 PAYMENT-REQUIRED header`,
      );
    }
    let envelope: {
      x402Version: number;
      accepts: {
        scheme: string;
        network: string;
        asset: string;
        amount: string;
        payTo: string;
        maxTimeoutSeconds: number;
        resource: string;
        description?: string;
        extra?: { quoteId?: string; expiresAt?: number; serviceId?: string; trialAvailable?: boolean };
      }[];
    };
    try {
      envelope = JSON.parse(Buffer.from(paymentRequiredB64, "base64").toString("utf8")) as typeof envelope;
    } catch {
      throw new ToolError("Quote probe failed: PAYMENT-REQUIRED header is not valid base64 JSON");
    }
    const requirement =
      envelope.accepts?.find((acc) => acc.scheme === "ane-vault-v1") ?? envelope.accepts?.[0];
    if (!requirement) {
      throw new ToolError("Quote probe failed: 402 envelope lists no payment requirements");
    }
    let manifestCheck: { valid: boolean; signer?: string; pay_to_matches?: boolean; reason?: string } | null =
      null;
    if (verifyManifest) {
      manifestCheck = await this.#checkOriginManifest(url, requirement.payTo);
    }
    const quote = {
      scheme: requirement.scheme,
      network: requirement.network,
      asset: requirement.asset,
      amount_base_units: requirement.amount,
      pay_to: requirement.payTo,
      max_timeout_seconds: requirement.maxTimeoutSeconds,
      resource: requirement.resource,
      description: requirement.description ?? "",
      quote_id: requirement.extra?.quoteId ?? null,
      expires_at: requirement.extra?.expiresAt ?? null,
      service_id: requirement.extra?.serviceId ?? null,
      trial_available: requirement.extra?.trialAvailable ?? false,
      manifest: manifestCheck,
    };
    const text =
      `Quote for ${method} ${url}: ${quote.amount_base_units} base units of tANE to ${quote.pay_to} ` +
      `(scheme ${quote.scheme}, network ${quote.network}).\n` +
      untrusted(
        truncate(
          `description: ${quote.description}\nresource: ${quote.resource}\nservice_id: ${quote.service_id ?? "(none)"}`,
        ),
      ) +
      `\n${manifestCheck ? `Manifest signature_valid=${manifestCheck.valid} pay_to_matches=${manifestCheck.pay_to_matches ?? "unchecked"}. ` : ""}` +
      `This quote signs nothing. ${SANDBOX_DISCLAIMER}`;
    return okResult(text, {
      payment_required: true,
      quote,
      untrusted: true,
      disclaimer: SANDBOX_DISCLAIMER,
    });
  }

  /** Fetches the origin's well-known manifest and cross-checks the quote payee. */
  async #checkOriginManifest(
    url: string,
    quotePayTo: string,
  ): Promise<{ valid: boolean; signer?: string; pay_to_matches?: boolean; reason?: string }> {
    const origin = new URL(url).origin;
    const probe = await this.#backend.probeUrl(`${origin}/.well-known/16ane-service.json`, {
      method: "GET",
      headers: { accept: "application/json" },
    });
    if (probe.status !== 200) {
      return { valid: false, reason: `No manifest at origin (HTTP ${probe.status})` };
    }
    let manifest: ServiceManifestPayload;
    try {
      manifest = JSON.parse(probe.text) as ServiceManifestPayload;
    } catch {
      return { valid: false, reason: "Origin manifest is not valid JSON" };
    }
    const check = this.#backend.verifyManifest(manifest);
    if (!check.valid) {
      return { valid: false, reason: check.reason ?? "Invalid manifest signature" };
    }
    const payToMatches = manifest.payTo.toLowerCase() === quotePayTo.toLowerCase();
    return { valid: true, signer: check.signer, pay_to_matches: payToMatches };
  }

  async #walletBalance(args: unknown): Promise<ToolResult> {
    requireArgs(args);
    const cfg = this.#backend.config;
    const { tokenBalance, accounting } = await this.#backend.getBalances();
    const structured: Record<string, unknown> = {
      vault: cfg.vaultAddress,
      session: cfg.sessionAddress,
      token: cfg.tokenAddress,
      token_symbol: "tANE",
      token_balance_base_units: tokenBalance.toString(),
      accounting: accounting
        ? {
            owner: accounting.owner,
            agent_signer: accounting.agentSigner,
            max_total_spend_base_units: accounting.maxTotalSpend.toString(),
            cumulative_spent_base_units: accounting.cumulativeSpent.toString(),
            authorized_remaining_base_units: accounting.authorizedRemaining.toString(),
            spendable_now_base_units: accounting.spendableNow.toString(),
            verified_revenue_base_units: accounting.verifiedRevenue.toString(),
            budget_mode: accounting.budgetMode,
            policy_version: accounting.policyVersion,
            expiry: accounting.expiry,
            active: accounting.active,
          }
        : null,
      untrusted: false,
      disclaimer: SANDBOX_DISCLAIMER,
    };
    const text = accounting
      ? `Vault ${cfg.vaultAddress}: token balance ${tokenBalance} base units, spendable now ` +
        `${accounting.spendableNow} (authorized remaining ${accounting.authorizedRemaining}, ` +
        `mode ${accounting.budgetMode}, active=${accounting.active}). ${SANDBOX_DISCLAIMER}`
      : `Vault ${cfg.vaultAddress}: token balance ${tokenBalance} base units (no vault accounting: ` +
        `not a vault contract). ${SANDBOX_DISCLAIMER}`;
    return okResult(text, structured);
  }

  async #paymentStatus(args: unknown): Promise<ToolResult> {
    const a = requireArgs(args);
    const paymentId = optionalString(a, "payment_id");
    const receiptId = optionalString(a, "receipt_id") ?? paymentId;
    if (!paymentId && !receiptId) {
      throw new ToolError("Provide at least one of 'payment_id' or 'receipt_id'");
    }
    let onchain: Record<string, unknown> | null = null;
    if (paymentId) {
      const record = await this.#backend.getPaymentRecord(paymentId);
      const exists = record.settledAt > 0 || record.amountPaid > 0n;
      onchain = {
        payment_id: paymentId,
        exists,
        merchant: record.merchant,
        amount_paid_base_units: record.amountPaid.toString(),
        amount_refunded_base_units: record.amountRefunded.toString(),
        settled_at: record.settledAt,
      };
    }
    const receipt = receiptId ? await this.#backend.getReceipt(receiptId) : null;
    const text =
      (onchain
        ? `Payment ${paymentId}: exists=${onchain["exists"]} merchant=${onchain["merchant"]} ` +
          `paid=${onchain["amount_paid_base_units"]} refunded=${onchain["amount_refunded_base_units"]}.`
        : "No on-chain lookup (no payment_id given).") +
      (receipt
        ? ` Receipt: scheme=${receipt.scheme} tx=${receipt.txHash} block=${receipt.blockNumber} ` +
          `sponsored=${receipt.sponsored ?? false}.`
        : " No receipt found.") +
      ` ${SANDBOX_DISCLAIMER}`;
    return okResult(text, {
      onchain,
      receipt,
      untrusted: false,
      disclaimer: SANDBOX_DISCLAIMER,
    });
  }

  async #purchaseService(args: unknown): Promise<ToolResult> {
    const a = requireArgs(args);
    const url = requireHttpUrl(requireString(a, "url"), "url");
    const maxPayment = parseAmount(a["max_payment"], "max_payment");
    const ceiling = this.#backend.config.maxPaymentCeiling;
    if (ceiling !== undefined && maxPayment > ceiling) {
      throw new ToolError(
        `Refused: call max_payment ${maxPayment} exceeds this server's per-call ceiling ${ceiling} base units`,
      );
    }
    const effectiveMax = ceiling !== undefined && ceiling < maxPayment ? ceiling : maxPayment;
    const body = optionalString(a, "body");
    const method = parseMethod(a["method"], body === undefined ? "GET" : "POST");
    const headers = a["headers"];
    if (headers !== undefined && !isRecord(headers)) {
      throw new ToolError("Argument 'headers' must be an object of string values");
    }
    const stringHeaders: Record<string, string> | undefined = headers
      ? Object.fromEntries(
          Object.entries(headers).map(([k, v]) => {
            if (typeof v !== "string") {
              throw new ToolError("Argument 'headers' must be an object of string values");
            }
            return [k, v];
          }),
        )
      : undefined;
    const result = await this.#backend.purchase(url, {
      method,
      headers: stringHeaders,
      body,
      maxPayment: effectiveMax,
      idempotencyKey: optionalString(a, "idempotency_key"),
      verifyManifest: optionalBoolean(a, "verify_manifest", true),
      verifyReceiptOnChain: optionalBoolean(a, "verify_receipt_on_chain", false),
    });
    const dataText = typeof result.data === "string" ? result.data : JSON.stringify(result.data);
    const receipt = result.receipt;
    const text =
      `Purchase HTTP ${result.status}. ` +
      (receipt
        ? `Receipt: payment_id=${receipt.paymentId ?? "(none)"} tx=${receipt.txHash} ` +
          `amount=${receipt.amount} sponsored=${receipt.sponsored ?? false}.`
        : "No payment receipt (endpoint answered without charging).") +
      `\nService result:\n${untrusted(truncate(dataText ?? "(empty)"))}` +
      `\n${SANDBOX_DISCLAIMER}`;
    return okResult(text, {
      status: result.status,
      receipt,
      trial_sponsored: result.trialSponsored,
      trial_remaining: result.trialRemaining ?? null,
      data: result.data,
      untrusted: true,
      disclaimer: SANDBOX_DISCLAIMER,
    });
  }

  async #publishService(args: unknown): Promise<ToolResult> {
    const a = requireArgs(args);
    const cfg = this.#backend.config;
    const serviceId = requireString(a, "service_id");
    const name = requireString(a, "name");
    const version = requireString(a, "version");
    const description = optionalString(a, "description");
    const manifestEndpoints = parseManifestEndpoints(a["endpoints"]);
    // Wallet-side policy: an agent publishes its own endpoint; revenue is
    // addressed to its vault, in tANE, on the configured network. No overrides.
    const unsigned = {
      schemaVersion: "16ane-manifest-v0" as const,
      serviceId,
      name,
      ...(description === undefined ? {} : { description }),
      version,
      network: cfg.network,
      chainId: cfg.chainId,
      payTo: cfg.vaultAddress,
      tokenAddress: cfg.tokenAddress,
      tokenSymbol: "tANE" as const,
      updatedAt: Math.floor(Date.now() / 1000),
      endpoints: manifestEndpoints,
    };
    const signed = this.#backend.signManifest(unsigned);
    const local = this.#backend.verifyManifest(signed);
    if (!local.valid) {
      throw new ToolError(`Refusing to publish a manifest that fails local verification: ${local.reason}`);
    }
    const receipt = await this.#backend.publishManifest(signed);
    const text =
      `Published ${serviceId} (${name}) v${version}: registered=${receipt.registered} ` +
      `signer=${receipt.signer} digest=${receipt.manifestDigest} pay_to=${cfg.vaultAddress}. ` +
      `${SANDBOX_DISCLAIMER}`;
    return okResult(text, {
      service_id: serviceId,
      registered: receipt.registered,
      signer: receipt.signer,
      manifest_digest: receipt.manifestDigest,
      pay_to: cfg.vaultAddress,
      manifest: signed,
      untrusted: false,
      disclaimer: SANDBOX_DISCLAIMER,
    });
  }

  async #requestRefund(args: unknown): Promise<ToolResult> {
    const a = requireArgs(args);
    const paymentId = requireString(a, "payment_id");
    const reason = optionalString(a, "reason");
    const record = await this.#backend.getPaymentRecord(paymentId);
    if (record.settledAt === 0 && record.amountPaid === 0n) {
      throw new ToolError(`No settled on-chain payment found for payment_id ${paymentId}`);
    }
    const remaining = record.amountPaid - record.amountRefunded;
    const requested = a["amount"] === undefined ? remaining : parseAmount(a["amount"], "amount");
    if (requested <= 0n) {
      throw new ToolError("Nothing left to refund: the payment is already fully refunded");
    }
    if (requested > remaining) {
      throw new ToolError(
        `Refused: requested ${requested} exceeds the unrefunded remainder ${remaining} base units`,
      );
    }
    const request = {
      payment_id: paymentId,
      vault: this.#backend.config.vaultAddress,
      merchant: record.merchant,
      amount_paid_base_units: record.amountPaid.toString(),
      amount_already_refunded_base_units: record.amountRefunded.toString(),
      requested_amount_base_units: requested.toString(),
      ...(reason === undefined ? {} : { reason }),
    };
    const text =
      `Refund request prepared for payment ${paymentId}: ${requested} of ${record.amountPaid} base ` +
      `units from merchant ${record.merchant}. This tool moves no funds: a finalized on-chain ` +
      `transfer cannot be reversed unilaterally, so deliver this request to the merchant out of ` +
      `band and only the merchant's refundPayment call settles it. ${SANDBOX_DISCLAIMER}`;
    return okResult(text, {
      refund_request: request,
      moves_funds: false,
      untrusted: false,
      disclaimer: SANDBOX_DISCLAIMER,
    });
  }
}
