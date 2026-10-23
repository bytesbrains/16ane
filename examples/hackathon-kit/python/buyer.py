"""A buyer agent in Python (#20).

It holds only the agent session key the owner delegated to; the vault contract enforces the
owner's budget no matter what this code (or a model driving it) decides.

    python3 examples/hackathon-kit/python/buyer.py                                        # demo summary
    python3 examples/hackathon-kit/python/buyer.py http://127.0.0.1:9102/v1/digits         # Python seller
    python3 examples/hackathon-kit/python/buyer.py http://127.0.0.1:9101/v1/word-count     # TS seller

Make it yours: decide what to buy, what to send, and the most you will pay (MAX_PAYMENT).
"""

from __future__ import annotations

import json
import sys

from kit import (
    ONE_TANE,
    SANDBOX_DISCLAIMER,
    AgentSession,
    client_for,
    load_or_create_key,
    read_agent,
    read_network,
    tane,
)

# A client-side guard on top of the contract's limits: refuse any quote above this.
MAX_PAYMENT = 32 * ONE_TANE


def buy(url: str, body: dict) -> dict:
    net = read_network()
    session = AgentSession(client_for(net), read_agent()["vaultAddress"], load_or_create_key("agent"))
    result = session.purchase(url, method="POST", body=json.dumps(body), max_payment=MAX_PAYMENT)
    return {
        "status": result["status"],
        "data": result["data"],
        "txHash": (result["receipt"] or {}).get("txHash"),
    }


def main() -> int:
    net = read_network()
    url = sys.argv[1] if len(sys.argv) > 1 else f"{net['apiUrl']}/v1/demo/summarize"
    text = sys.argv[2] if len(sys.argv) > 2 else "Order 16 cost 1,600 tANE in the sandbox."
    print(f"[{net['name']}] {SANDBOX_DISCLAIMER}\nbuying {url}")
    out = buy(url, {"text": text})
    print(json.dumps(out, indent=2, ensure_ascii=False))
    summary = client_for(net).get_accounting_summary(read_agent()["vaultAddress"])
    print(f"spent so far {tane(summary['cumulativeSpent'])}; may still spend {tane(summary['spendableNow'])}")
    return 0 if out["status"] == 200 else 1


if __name__ == "__main__":
    sys.exit(main())
