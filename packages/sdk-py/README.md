# ane-sdk (Python)

Python SDK for the 16ane agent-economy sandbox: owner and agent-session wallets, x402 v2 payments
settled through `AneAgentVault`, signed service manifests, and direct on-chain receipt verification.

> **TEST TOKENS (tANE) — NO CASH VALUE.** `tANE` is a free, simulated testnet token. It is not
> backed by INR, not redeemable, and not convertible to any future `ANE`.

Status: `0.1.0`, not yet published to PyPI. Nothing is deployed to a public network; use a local
Anvil chain (see the repository's E2E harness) or your own Base Sepolia deployment.

## Use from a checkout

```bash
python3 -m unittest discover -s packages/sdk-py/tests -p 'test_*.py' -v
```

```python
import sys
sys.path.insert(0, "packages/sdk-py")
from ane_sdk import AneClient, AgentSession

client = AneClient(rpc_url="http://127.0.0.1:8545", chain_id=84532, registry_address="0x...")
```

Requires Python 3.11+ and has no third-party dependencies. See the
[repository README](https://github.com/bytesbrains/16ane#readme) for the protocol, threat model and ADRs.
