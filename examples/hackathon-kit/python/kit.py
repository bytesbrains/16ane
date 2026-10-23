"""Shared helpers for the Python side of the hackathon kit (#20).

Reads the same state as the TypeScript scripts: ``.kit/network.json`` (written by
``npm run kit:sandbox`` or ``npm run kit:owner -- setup --network sandbox``) and the key files
next to it. Keys are only ever held as ``SecretKey``, which never prints its value.
"""

from __future__ import annotations

import json
import os
import secrets
import sys
from pathlib import Path

KIT_DIR = Path(__file__).resolve().parent.parent
REPO_ROOT = KIT_DIR.parent.parent
sys.path.insert(0, str(REPO_ROOT / "packages" / "sdk-py"))

from ane_sdk import (
    AgentSession,
    AneClient,
    SecretKey,
    compute_request_hash,
    compute_resource_hash,
    private_key_to_address,
    random_bytes32_hex,
)

# The buyer and seller import the SDK through this module, which puts it on sys.path first.
__all__ = [
    "AgentSession",
    "compute_request_hash",
    "compute_resource_hash",
    "random_bytes32_hex",
]

STATE_DIR = Path(os.environ.get("KIT_STATE_DIR", KIT_DIR / ".kit"))
ONE_TANE = 10**18
SANDBOX_DISCLAIMER = "TEST TOKENS (tANE) - NO CASH VALUE"


def read_network() -> dict:
    path = STATE_DIR / "network.json"
    if not path.exists():
        sys.exit(
            "No network chosen yet. Start a local sandbox (npm run kit:sandbox) or run "
            "`npm run kit:owner -- setup --network sandbox` for the public one."
        )
    return json.loads(path.read_text())


def read_agent() -> dict:
    path = STATE_DIR / "agent.json"
    if not path.exists():
        sys.exit("No agent yet. Run `npm run kit:owner -- setup` first.")
    return json.loads(path.read_text())


def client_for(net: dict) -> AneClient:
    return AneClient(rpc_url=net["rpcUrl"], chain_id=net["chainId"], registry_address=net["registryAddress"])


def load_or_create_key(name: str) -> SecretKey:
    """Loads .kit/<name>.key, creating it (mode 600) on first use. Never paste it into a prompt or log."""
    path = STATE_DIR / f"{name}.key"
    if not path.exists():
        STATE_DIR.mkdir(parents=True, exist_ok=True)
        fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(fd, "w") as f:
            f.write("0x" + secrets.token_hex(32) + "\n")
    return SecretKey(path.read_text().strip())


def address_of(key: SecretKey) -> str:
    return private_key_to_address(key._unsafe_unwrap())


def tane(amount: int | str) -> str:
    """1234500000000000000 -> '1.2345 tANE'."""
    whole, frac = divmod(int(amount), ONE_TANE)
    frac_str = str(frac).rjust(18, "0").rstrip("0")
    return f"{whole}{'.' + frac_str if frac_str else ''} tANE"
