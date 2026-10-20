// Health check for a hosted sandbox API (#78): reads GET /healthz and names anything an operator must act on.
// The scheduled monitor (.github/workflows/api-monitor.yml) runs it and opens an issue when it fails:
//   node --experimental-strip-types scripts/api-health.ts https://api.16ane.com
// Exit codes: 0 healthy, 1 a problem was found (printed one per line), 2 bad usage.

export interface HealthReport {
  status?: string;
  chainId?: number;
  registry?: string;
  relayer?: {
    address?: string;
    balanceWei?: string;
    dailyGasBudgetWei?: string;
    remainingTodayWei?: string;
    lowBalance?: boolean;
  };
}

// Each problem says what is wrong and what to do; docs/operations/OPERATIONS.md has the runbook.
export function assessHealth(httpStatus: number, body: HealthReport, expectedRegistry?: string): string[] {
  if (httpStatus !== 200 || body.status !== "ok") {
    return [`/healthz answered ${httpStatus} (${body.status ?? "no status"}): the server can't reach its RPC`];
  }
  const problems: string[] = [];
  if (expectedRegistry && body.registry?.toLowerCase() !== expectedRegistry.toLowerCase()) {
    problems.push(`registry is ${body.registry}, expected ${expectedRegistry}: the server points at another deployment`);
  }
  const relayer = body.relayer;
  if (!relayer || relayer.balanceWei === undefined || relayer.remainingTodayWei === undefined) {
    problems.push("/healthz has no relayer section: is this the 16ane sandbox server?");
    return problems;
  }
  if (relayer.lowBalance) {
    problems.push(
      `relayer ${relayer.address} holds ${relayer.balanceWei} wei, less than what's left of today's gas budget: top it up`,
    );
  }
  if (BigInt(relayer.remainingTodayWei) === 0n) {
    problems.push(
      `today's relayer gas budget (${relayer.dailyGasBudgetWei} wei) is used up: sponsorship is paused until 00:00 UTC`,
    );
  }
  return problems;
}

export async function checkApiHealth(apiUrl: string, expectedRegistry?: string): Promise<string[]> {
  let res: Response;
  try {
    res = await fetch(new URL("/healthz", apiUrl), { signal: AbortSignal.timeout(15_000) });
  } catch (err) {
    return [`${apiUrl} is unreachable: ${err instanceof Error ? err.message : String(err)}`];
  }
  let body: HealthReport = {};
  try {
    body = (await res.json()) as HealthReport;
  } catch {
    // A non-JSON answer (a proxy error page) is reported through the status below.
  }
  return assessHealth(res.status, body, expectedRegistry);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const apiUrl = process.argv[2];
  if (!apiUrl) {
    console.error("Usage: api-health.ts <api-url> [expected-registry]");
    process.exit(2);
  }
  const problems = await checkApiHealth(apiUrl, process.argv[3]);
  for (const p of problems) console.log(p);
  if (problems.length === 0) console.log(`${apiUrl}: healthy`);
  process.exit(problems.length === 0 ? 0 : 1);
}
