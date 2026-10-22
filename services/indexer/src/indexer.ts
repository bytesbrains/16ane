// Service-directory indexer (ADR-0007, #18): polls ServiceAnchored events from standard RPC logs and
// serves the anchor set over HTTP. Anchors are untrusted advertisements — clients fetch the manifest
// from manifestUri themselves and verify its signature offline with the SDK; the indexer never fetches
// third-party URLs (no SSRF surface) and never judges a manifest.
import { keccak256Utf8, toChecksumAddress, type AneClient, type KeyValueStore } from "../../../packages/sdk-ts/src/index.ts";

export const SERVICE_ANCHORED_TOPIC = keccak256Utf8("ServiceAnchored(bytes32,address,string,bytes32,uint64,uint8)");

export type AnchorStatus = "ACTIVE" | "PAUSED" | "DEPRECATED" | "NONE";

export interface ServiceAnchorRecord {
  serviceIdHash: string;
  provider: string;
  manifestUri: string;
  manifestHash: string;
  expiresAt: number;
  status: AnchorStatus;
  blockNumber: number;
  txHash: string;
}

/** Junk guard: an unbounded string in a log must not become an unbounded stored value. */
export const MAX_MANIFEST_URI_CHARS = 2048;

const STATUS_NAMES: Record<number, AnchorStatus> = { 0: "NONE", 1: "ACTIVE", 2: "PAUSED", 3: "DEPRECATED" };

function words(hexData: string): string[] {
  const clean = hexData.startsWith("0x") ? hexData.slice(2) : hexData;
  const out: string[] = [];
  for (let i = 0; i + 64 <= clean.length; i += 64) out.push(clean.slice(i, i + 64));
  return out;
}

/**
 * Decodes one ServiceAnchored log. Returns undefined for anything that is not exactly that event —
 * a corrupt or foreign log is skipped, never allowed to wedge the scan.
 */
export function decodeServiceAnchored(log: {
  topics?: unknown;
  data?: unknown;
  blockNumber?: unknown;
  transactionHash?: unknown;
}): ServiceAnchorRecord | undefined {
  try {
    const topics = log.topics;
    if (!Array.isArray(topics) || topics.length < 3) return undefined;
    const [sig, idHash, provider] = topics;
    if (typeof sig !== "string" || sig.toLowerCase() !== SERVICE_ANCHORED_TOPIC.toLowerCase()) return undefined;
    if (typeof idHash !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(idHash)) return undefined;
    if (typeof provider !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(provider)) return undefined;
    if (typeof log.data !== "string") return undefined;
    if (typeof log.transactionHash !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(log.transactionHash)) return undefined;
    const blockNumber =
      typeof log.blockNumber === "string" && /^0x[0-9a-fA-F]+$/.test(log.blockNumber)
        ? Number(BigInt(log.blockNumber))
        : undefined;
    if (blockNumber === undefined || !Number.isSafeInteger(blockNumber)) return undefined;

    // data = string offset, manifestHash, expiresAt, status, then the string length and bytes.
    const w = words(log.data);
    if (w.length < 5) return undefined;
    const stringAt = Number(BigInt("0x" + w[0]));
    if (!Number.isSafeInteger(stringAt) || stringAt % 32 !== 0 || stringAt / 32 + 1 > w.length) return undefined;
    const strLen = Number(BigInt("0x" + w[stringAt / 32]));
    if (!Number.isSafeInteger(strLen) || strLen < 0 || strLen > MAX_MANIFEST_URI_CHARS) return undefined;
    const strWords = w.slice(stringAt / 32 + 1, stringAt / 32 + 1 + Math.ceil(strLen / 32));
    if (strWords.join("").length < strLen * 2) return undefined;
    const manifestUri = Buffer.from(strWords.join("").slice(0, strLen * 2), "hex").toString("utf8");
    if (!manifestUri || /[\x00-\x1f\x7f]/.test(manifestUri)) return undefined;

    const manifestHash = "0x" + w[1];
    if (/^0x0+$/.test(manifestHash)) return undefined;
    const expiresAt = Number(BigInt("0x" + w[2]));
    const status = STATUS_NAMES[Number(BigInt("0x" + w[3]))];
    if (!Number.isSafeInteger(expiresAt) || status === undefined) return undefined;
    return {
      serviceIdHash: idHash.toLowerCase(),
      provider: toChecksumAddress("0x" + provider.slice(-40)),
      manifestUri,
      manifestHash: manifestHash.toLowerCase(),
      expiresAt,
      status,
      blockNumber,
      txHash: log.transactionHash.toLowerCase(),
    };
  } catch {
    return undefined;
  }
}

const ANCHORS_NS = "directory.anchors";
const CURSOR_NS = "directory.index";
const CURSOR_KEY = "last-scanned-block";

export interface IndexerOptions {
  fromBlock?: number | "latest" | "earliest";
  /** Milliseconds between scans. Defaults to 5000. */
  pollMs?: number;
  /** Most blocks per eth_getLogs call; public RPCs cap ranges. Defaults to 2000. */
  maxRange?: number;
}

interface EthLog {
  topics?: unknown;
  data?: unknown;
  blockNumber?: unknown;
  transactionHash?: unknown;
  logIndex?: unknown;
}

const logIndexOf = (log: EthLog): number => {
  if (typeof log.logIndex === "string" && /^0x[0-9a-fA-F]+$/.test(log.logIndex)) return Number(BigInt(log.logIndex));
  return 0;
};

// Unparseable numbers sort first; the decoder below drops them. A foreign log in the range must
// never throw the sort and wedge the cursor.
const blockNumOf = (log: EthLog): number => {
  try {
    return typeof log.blockNumber === "string" ? Number(BigInt(log.blockNumber)) : 0;
  } catch {
    return 0;
  }
};

export class ServiceDirectoryIndexer {
  readonly #client: AneClient;
  readonly #directory: string;
  readonly #store: KeyValueStore;
  readonly #fromBlock: number | "latest" | "earliest";
  readonly #pollMs: number;
  readonly #maxRange: number;
  #timer: ReturnType<typeof setInterval> | undefined;
  #scanning = false;
  #lastError: string | undefined;
  #lastScanAt: string | undefined;

  constructor(client: AneClient, directoryAddress: string, store: KeyValueStore, opts: IndexerOptions = {}) {
    this.#client = client;
    this.#directory = directoryAddress;
    this.#store = store;
    this.#fromBlock = opts.fromBlock ?? "latest";
    this.#pollMs = opts.pollMs ?? 5000;
    this.#maxRange = opts.maxRange ?? 2000;
  }

  get lastError(): string | undefined {
    return this.#lastError;
  }

  get lastScanAt(): string | undefined {
    return this.#lastScanAt;
  }

  get lastScannedBlock(): number | undefined {
    return this.#store.get<number>(CURSOR_NS, CURSOR_KEY);
  }

  listAnchors(filters: { provider?: string; status?: AnchorStatus } = {}): ServiceAnchorRecord[] {
    const all = this.#store.values<ServiceAnchorRecord>(ANCHORS_NS);
    return all
      .filter((a) => filters.provider === undefined || a.provider.toLowerCase() === filters.provider.toLowerCase())
      .filter((a) => filters.status === undefined || a.status === filters.status)
      .sort((a, b) => a.blockNumber - b.blockNumber || (a.txHash < b.txHash ? -1 : 1));
  }

  getAnchor(serviceIdHash: string): ServiceAnchorRecord | undefined {
    return this.#store.get<ServiceAnchorRecord>(ANCHORS_NS, serviceIdHash.toLowerCase());
  }

  /** One scan pass: every chunk from the cursor to the latest block, in log order. */
  async scanOnce(): Promise<{ scannedTo: number; upserted: number }> {
    const latest = Number(BigInt(await this.#client.rpcCall<string>("eth_blockNumber", [])));
    let from = this.#store.get<number>(CURSOR_NS, CURSOR_KEY);
    if (from === undefined) {
      from = this.#fromBlock === "latest" ? latest : this.#fromBlock === "earliest" ? 0 : this.#fromBlock;
      if (from > latest) {
        this.#store.set(CURSOR_NS, CURSOR_KEY, latest);
        return { scannedTo: latest, upserted: 0 };
      }
    } else {
      from += 1;
      if (from > latest) return { scannedTo: latest, upserted: 0 };
    }
    let upserted = 0;
    let cursor = from - 1;
    // Chunks keep each eth_getLogs call inside public-RPC range caps; the cursor advances per chunk so
    // a failure mid-backfill resumes where it stopped instead of restarting the range.
    for (let start = from; start <= latest; start += this.#maxRange) {
      const end = Math.min(start + this.#maxRange - 1, latest);
      const logs = await this.#client.rpcCall<EthLog[]>("eth_getLogs", [
        {
          address: this.#directory,
          topics: [SERVICE_ANCHORED_TOPIC],
          fromBlock: "0x" + start.toString(16),
          toBlock: "0x" + end.toString(16),
        },
      ]);
      const ordered = [...logs].sort(
        (a, b) => blockNumOf(a) - blockNumOf(b) || logIndexOf(a) - logIndexOf(b),
      );
      for (const log of ordered) {
        const anchor = decodeServiceAnchored(log);
        if (anchor) {
          this.#store.set(ANCHORS_NS, anchor.serviceIdHash, anchor);
          upserted += 1;
        }
      }
      cursor = end;
      this.#store.set(CURSOR_NS, CURSOR_KEY, cursor);
    }
    return { scannedTo: cursor, upserted };
  }

  /** Starts the poll loop. A failed scan is recorded for /healthz and retried; it never stops the loop. */
  start(): void {
    if (this.#timer) return;
    const tick = async () => {
      if (this.#scanning) return;
      this.#scanning = true;
      try {
        await this.scanOnce();
        this.#lastError = undefined;
        this.#lastScanAt = new Date().toISOString();
      } catch (err) {
        this.#lastError = (err instanceof Error ? err.message : String(err)).slice(0, 300);
      } finally {
        this.#scanning = false;
      }
    };
    void tick();
    this.#timer = setInterval(() => void tick(), this.#pollMs);
  }

  async stop(): Promise<void> {
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = undefined;
    while (this.#scanning) await new Promise((resolve) => setTimeout(resolve, 25));
  }
}
