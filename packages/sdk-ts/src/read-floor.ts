// Read-after-write consistency on public load-balanced RPCs (#67). Straight after a write, a node that hasn't
// seen its block answers with the old state (a stale policyVersion, a missing payment record, no receipt). For
// a while after the last confirmed write, state reads therefore go to an explicit block no older than that
// write, and wait while the node answering is behind. Later reads use "latest" again, so a long-running client
// doesn't pay an extra eth_blockNumber per read forever; public RPC lag is seconds, not minutes.

const READ_LAG_RETRY_DELAYS_MS = [250, 500, 1000, 2000, 4000];
// What a node answers for a block it hasn't reached: "block not found" (sepolia.base.org, publicnode),
// "header not found" (geth). The tag is always a block some node already reported as its head, so the block
// exists; the error can only mean the answering node is behind. Retries are bounded, then the error is rethrown.
const LAGGING_NODE = /header not found|unknown block|block not found|cannot query unfinalized data/i;
export const RECEIPT_RETRY_DELAYS_MS = [500, 1000, 2000];
export const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

type Rpc = <T>(method: string, params: unknown[]) => Promise<T>;

export class ReadFloor {
  readonly #windowMs: number;
  readonly #rpc: Rpc;
  #floor?: { block: bigint; until: number };

  constructor(windowMs: number, rpc: Rpc) {
    this.#windowMs = windowMs;
    this.#rpc = rpc;
  }

  // Each observation holds reads at or above max(blocks seen) for a full window from now: an older block seen
  // later is still a write someone wants to read, and the higher floor covers it.
  observe(blockNumber: number | bigint): void {
    if (this.#windowMs <= 0) return;
    const block = BigInt(blockNumber);
    const floor = this.#floor;
    this.#floor = { block: floor && floor.block > block ? floor.block : block, until: Date.now() + this.#windowMs };
  }

  // A state read (eth_call, eth_getCode, eth_getBalance) at "latest", or while a floor is active, at the head
  // of a node that has reached it. A load balancer can send the read to a different node than the one that
  // reported the head; that node rejects an unknown block, so retry.
  async read<T>(method: string, params: unknown[]): Promise<T> {
    const tag = await this.#blockTag();
    for (let attempt = 0; ; attempt++) {
      try {
        return await this.#rpc<T>(method, [...params, tag]);
      } catch (err) {
        const delay = READ_LAG_RETRY_DELAYS_MS[attempt];
        if (tag === "latest" || delay === undefined || !LAGGING_NODE.test(String(err))) throw err;
        await sleep(delay);
      }
    }
  }

  async #blockTag(): Promise<string> {
    const floor = this.#floor;
    if (!floor || Date.now() > floor.until) return "latest";
    let head = 0n;
    for (let attempt = 0; ; attempt++) {
      head = BigInt(await this.#rpc<string>("eth_blockNumber", []));
      if (head >= floor.block) return "0x" + head.toString(16);
      const delay = READ_LAG_RETRY_DELAYS_MS[attempt];
      if (delay === undefined) break;
      await sleep(delay);
    }
    throw new Error(`RPC node is behind this client's last write (block ${floor.block}, node at ${head})`);
  }
}
