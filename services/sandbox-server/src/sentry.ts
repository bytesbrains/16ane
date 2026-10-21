import { redactUrls } from "./http.ts";

const CLIENT = "16ane-sandbox/0.1.0";

/** Public key, ingest host and project id from a Sentry DSN (`https://key@host/projectId`). */
export interface SentryDsn {
  publicKey: string;
  host: string;
  projectId: string;
  /** Full DSN string as given (used in the envelope header). */
  dsn: string;
  envelopeUrl: string;
}

export type SentryFetch = (
  input: string,
  init: { method: string; headers: Record<string, string>; body: string },
) => Promise<{ ok: boolean; status: number }>;

/**
 * Parse a Sentry DSN. Returns undefined when the string is empty or not a usable DSN
 * (no secrets are echoed in the failure path).
 */
export function parseSentryDsn(raw: string | undefined): SentryDsn | undefined {
  const dsn = raw?.trim();
  if (!dsn) return undefined;
  let url: URL;
  try {
    url = new URL(dsn);
  } catch {
    return undefined;
  }
  if (!/^https?:$/.test(url.protocol)) return undefined;
  const publicKey = url.username;
  // Path is `/<projectId>`; ignore a trailing slash.
  const projectId = url.pathname.replace(/^\/+|\/+$/g, "").split("/")[0];
  if (!publicKey || !projectId || !/^\d+$/.test(projectId)) return undefined;
  return {
    publicKey,
    host: url.host,
    projectId,
    dsn,
    envelopeUrl: `${url.protocol}//${url.host}/api/${projectId}/envelope/`,
  };
}

/**
 * Scrub text that may leave the host for Sentry (#90, ADR-0010): URLs (RPC keys in them) and
 * 32-byte-or-longer hex values (private keys, spend-intent signatures). Request bodies, headers,
 * query strings, client IPs and Turnstile tokens are never attached to the event at all.
 */
export function scrubErrorDetail(text: string): string {
  let out = redactUrls(text);
  // Private keys are 0x + 64 hex; ECDSA signatures are longer (typically 65 bytes → 130 hex).
  out = out.replace(/\b0x[0-9a-fA-F]{64,130}\b/g, "<hex>");
  // If a cause message echoed auth material, strip it (request fields themselves are never attached).
  // Bearer first so `Authorization: Bearer <token>` loses the token value too, not just the scheme word.
  out = out.replace(/\bBearer\s+\S+/gi, "Bearer <redacted>");
  out = out.replace(/\bAuthorization\s*:\s*\S+/gi, "Authorization: <redacted>");
  // Drop the whole Turnstile pair, name included: only code/errorId and the scrubbed message leave the host.
  out = out.replace(/\b(turnstileToken|cf-turnstile-response)\s*[:=]\s*\S+/gi, "<redacted>");
  return out;
}

export interface LoggedErrorReport {
  code: string;
  errorId: string;
  /** Underlying cause text; scrubbed before anything is built. */
  detail: string;
}

/**
 * Build the three-line Sentry envelope and the event object.
 * The event carries only `code`, `errorId` and a scrubbed message — no request, user, IP or headers.
 */
export function buildSentryEnvelope(report: LoggedErrorReport, dsn: SentryDsn, now = new Date()): {
  eventId: string;
  envelope: string;
  event: Record<string, unknown>;
} {
  const message = scrubErrorDetail(report.detail).slice(0, 8_000);
  // Sentry event_id is 32 hex chars; the client's errorId is already a UUID.
  const eventId = report.errorId.replace(/-/g, "").toLowerCase();
  const sentAt = now.toISOString();
  const event: Record<string, unknown> = {
    event_id: eventId,
    timestamp: now.getTime() / 1000,
    platform: "node",
    level: "error",
    logger: "16ane-sandbox",
    transaction: report.code,
    message: { formatted: message },
    tags: { errorId: report.errorId, code: report.code },
    fingerprint: [report.code],
    sdk: { name: "16ane.sandbox.http", version: "0.1.0" },
  };
  // Explicitly omit request / user / contexts that would carry bodies, headers or IPs.
  const envelopeHeader = JSON.stringify({ event_id: eventId, sent_at: sentAt, dsn: dsn.dsn });
  const itemHeader = JSON.stringify({ type: "event", content_type: "application/json" });
  const envelope = `${envelopeHeader}\n${itemHeader}\n${JSON.stringify(event)}\n`;
  return { eventId, envelope, event };
}

/** POST one scrubbed logged-error event. Failures are swallowed by the caller. */
export async function postSentryEnvelope(
  dsn: SentryDsn,
  report: LoggedErrorReport,
  fetchImpl: SentryFetch = fetch as SentryFetch,
): Promise<void> {
  const { envelope } = buildSentryEnvelope(report, dsn);
  await fetchImpl(dsn.envelopeUrl, {
    method: "POST",
    headers: {
      "content-type": "application/x-sentry-envelope",
      "user-agent": CLIENT,
      "x-sentry-auth": `Sentry sentry_version=7, sentry_client=${CLIENT}, sentry_key=${dsn.publicKey}`,
    },
    body: envelope,
  });
}

/**
 * Fire-and-forget reporter for `sendLoggedError`. Returns undefined when the DSN is unset or invalid
 * so self-hosters stay off by default (#90).
 */
export function createSentryReporter(
  rawDsn: string | undefined,
  fetchImpl: SentryFetch = fetch as SentryFetch,
): ((report: LoggedErrorReport) => void) | undefined {
  const dsn = parseSentryDsn(rawDsn);
  if (!dsn) {
    if (rawDsn?.trim()) {
      console.warn("[16ane-sandbox] ANE_SENTRY_DSN is set but not a usable Sentry DSN; error reporting stays off");
    }
    return undefined;
  }
  return (report) => {
    void postSentryEnvelope(dsn, report, fetchImpl).catch(() => {
      // Ingest failures must never affect the API response.
    });
  };
}
