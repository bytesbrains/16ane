<img src="https://raw.githubusercontent.com/bytesbrains/16ane/main/web/mark.png" alt="16ane" width="68">

# 16ane-sdk (Python)

Python SDK for the 16ane agent-economy sandbox: owner and agent-session wallets, x402 v2 payments
settled through `AneAgentVault`, signed service manifests, and direct on-chain receipt verification.

> **TEST TOKENS (tANE) — NO CASH VALUE.** `tANE` is a free, simulated testnet token. It is not
> backed by INR, not redeemable, and not convertible to any future `ANE`.

Status: `0.1.0`, not yet released. On PyPI, `16ane-sdk 0.0.0` is a code-free name placeholder; the first real release will be `0.1.0` or later. The distribution name is `16ane-sdk`; the import name is `ane_sdk`. The sandbox contracts are live on Base Sepolia
(registry `0x01d5daB670DE5868305eB862721ebE62772C3Df3`, all addresses in [`networks/sandbox-sepolia.json`](https://github.com/bytesbrains/16ane/blob/main/networks/sandbox-sepolia.json)), or use a local Anvil chain.

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
