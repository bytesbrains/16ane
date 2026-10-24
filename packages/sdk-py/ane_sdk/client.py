"""Python client, SecretKey redaction, and AgentSession x402 v2 flow for ane_sdk."""

from __future__ import annotations

import base64
import json
import re
import time
import urllib.error
import urllib.request
from typing import Any, Dict, List, Optional, Tuple
from urllib.parse import urlparse

from .crypto import (
    abi_word_address,
    compute_payment_id,
    compute_request_hash,
    compute_resource_hash,
    compute_task_quote_id,
    hash_service_manifest,
    hash_spend_intent,
    hash_task_release,
    keccak256_utf8,
    private_key_to_address,
    random_bytes32_hex,
    recover_address,
    sign_digest,
    to_checksum_address,
)

REDACTED_PRIVATE_KEY = "[REDACTED_PRIVATE_KEY]"


def redact_secrets(text: str, known_secrets: Optional[List[str]] = None) -> str:
    out = text
    for secret in known_secrets or []:
        clean = secret[2:] if secret.startswith(("0x", "0X")) else secret
        if len(clean) == 64:
            out = re.sub(
                rf"(?:0x)?{re.escape(clean)}", REDACTED_PRIVATE_KEY, out, flags=re.IGNORECASE
            )
    out = re.sub(
        r'((?:private[_-]?key|secret[_-]?key|owner[_-]?key|session[_-]?key|signing[_-]?key)["\'\s:=]+)(?:0x)?[0-9a-fA-F]{64}',
        rf"\1{REDACTED_PRIVATE_KEY}",
        out,
        flags=re.IGNORECASE,
    )
    return out


class SecretKey:
    """Inspect-safe wrapper for a 32-byte secp256k1 private key (REQ-003, ADR-0010)."""

    __slots__ = ("_raw_hex",)

    def __init__(self, private_key_hex: str) -> None:
        clean = private_key_hex.strip().lower()
        if clean.startswith("0x"):
            clean = clean[2:]
        if len(clean) != 64 or int(clean, 16) == 0:
            raise ValueError("Invalid 32-byte secp256k1 private key")
        object.__setattr__(self, "_raw_hex", "0x" + clean)

    def _unsafe_unwrap(self) -> str:
        return object.__getattribute__(self, "_raw_hex")

    def __str__(self) -> str:
        return REDACTED_PRIVATE_KEY

    def __repr__(self) -> str:
        return f"SecretKey({REDACTED_PRIVATE_KEY})"


def _selector(sig: str) -> str:
    return keccak256_utf8(sig)[:10]


def _split_words(hex_data: str) -> List[str]:
    clean = hex_data[2:] if hex_data.startswith("0x") else hex_data
    return [clean[i : i + 64] for i in range(0, len(clean), 64) if len(clean[i : i + 64]) == 64]


class AneClient:
    """JSON-RPC and contract verification client for the 16ane Sandbox."""

    def __init__(
        self,
        rpc_url: str,
        chain_id: int = 84532,
        registry_address: Optional[str] = None,
    ) -> None:
        self.rpc_url = rpc_url
        self.chain_id = chain_id
        self.registry_address = registry_address
        self._contracts: Optional[Dict[str, str]] = None

    def rpc_call(self, method: str, params: Optional[List[Any]] = None) -> Any:
        payload = json.dumps(
            {"jsonrpc": "2.0", "id": 1, "method": method, "params": params or []}
        ).encode("utf-8")
        req = urllib.request.Request(
            self.rpc_url,
            data=payload,
            headers={"content-type": "application/json"},
            method="POST",
        )
        with urllib.request.urlopen(req, timeout=15) as resp:
            body = json.loads(resp.read().decode("utf-8"))
        if "error" in body and body["error"]:
            raise RuntimeError(f"RPC error: {body['error']}")
        return body.get("result")

    def eth_call(self, to: str, data: str) -> str:
        return self.rpc_call("eth_call", [{"to": to, "data": data}, "latest"])

    def resolve_contracts(self) -> Dict[str, str]:
        if self._contracts is not None:
            return self._contracts
        if not self.registry_address:
            raise ValueError("registry_address is required on AneClient")
        sel = _selector("getDeployment()")
        out = self.eth_call(self.registry_address, sel)
        words = _split_words(out)
        self._contracts = {
            "registry": to_checksum_address(self.registry_address),
            "aneTestToken": to_checksum_address("0x" + words[0][-40:]),
            "aneVaultFactory": to_checksum_address("0x" + words[1][-40:]),
            "aneFaucet": to_checksum_address("0x" + words[2][-40:]),
            "aneServiceDirectory": to_checksum_address("0x" + words[3][-40:]),
        }
        return self._contracts

    def get_token_balance(self, account: str) -> int:
        contracts = self.resolve_contracts()
        sel = _selector("balanceOf(address)")
        out = self.eth_call(contracts["aneTestToken"], sel + abi_word_address(account))
        return int(_split_words(out)[0], 16)

    def get_available_to_spend(self, vault_address: str) -> int:
        sel = _selector("spendableBalance()")
        out = self.eth_call(vault_address, sel)
        return int(_split_words(out)[0], 16)

    def get_policy_version(self, vault_address: str) -> int:
        sel = _selector("policyVersion()")
        out = self.eth_call(vault_address, sel)
        return int(_split_words(out)[0], 16)

    def get_accounting_summary(self, vault_address: str) -> Dict[str, Any]:
        sel = _selector("getAccountingSummary()")
        out = self.eth_call(vault_address, sel)
        raw = _split_words(out)
        w = [int(word, 16) for word in raw]
        return {
            "owner": to_checksum_address("0x" + raw[0][-40:]),
            "agentSigner": to_checksum_address("0x" + raw[1][-40:]),
            "tokenBalance": w[2],
            "ownerPrincipalDeposited": w[3],
            "maxTotalSpend": w[4],
            "cumulativeSpent": w[5],
            "authorizedRemaining": w[6],
            "spendableNow": w[7],
            "verifiedRevenue": w[8],
            "unallocatedBalance": w[9],
            "policyVersion": w[10],
            "expiry": w[11],
            "budgetMode": "REVOLVING" if w[12] == 1 else "FIXED",
            "revolvingTreasuryCeiling": w[13],
            "active": w[14] != 0,
        }

    def verify_service_manifest(
        self,
        manifest: Dict[str, Any],
        directory_address: Optional[str] = None,
    ) -> Dict[str, Any]:
        sig = manifest.get("signature")
        signer = manifest.get("signer")
        if not sig or not signer:
            return {"valid": False, "reason": "Missing signature or signer"}
        dir_addr = directory_address or (
            self._contracts["aneServiceDirectory"]
            if self._contracts
            else "0x0000000000000000000000000000000000000000"
        )
        _, digest = hash_service_manifest(manifest, dir_addr)
        recovered = recover_address(digest, sig)
        if recovered.lower() != signer.lower():
            return {
                "valid": False,
                "signer": recovered,
                "digest": digest,
                "reason": f"Signer mismatch: recovered {recovered}, expected {signer}",
            }
        return {"valid": True, "signer": recovered, "digest": digest}


_BASE_UNITS = re.compile(r"(0|[1-9][0-9]*)")


def select_vault_requirement(
    accepts: Any, chain_id: int, asset: str
) -> Tuple[Optional[Dict[str, Any]], List[str]]:
    """Picks the cheapest `ane-vault-v1` quote in `asset` on `chain_id` (ADR-0019). The vault pays only its own
    token, so an amount quoted in any other asset, or on another chain, would be read in the wrong units."""
    want = to_checksum_address(asset)
    matches: List[Tuple[int, Dict[str, Any]]] = []
    rejected: List[str] = []
    for item in accepts if isinstance(accepts, list) else []:
        if not isinstance(item, dict):
            rejected.append("not an object")
            continue
        # Quote fields are provider text: quoted and cut short before they reach a log or a prompt.
        if item.get("scheme") != "ane-vault-v1":
            rejected.append(f"scheme {json.dumps(str(item.get('scheme'))[:48])} is not accepted")
            continue
        try:
            got = to_checksum_address(str(item.get("asset")))
            to_checksum_address(str(item.get("payTo")))
        except ValueError:
            rejected.append("malformed asset or payTo address")
            continue
        if got != want:
            rejected.append(f"asset {got} is not accepted")
            continue
        if item.get("network") != f"eip155:{chain_id}":
            rejected.append(f"asset {got} is not accepted on {json.dumps(str(item.get('network'))[:48])}")
            continue
        amount = item.get("amount")
        if not isinstance(amount, str) or not _BASE_UNITS.fullmatch(amount) or int(amount) >= 2**256:
            rejected.append("amount is not a base-unit integer")
            continue
        matches.append((int(amount), item))
    if not isinstance(accepts, list) or not accepts:
        rejected.append("no payment options offered")
    matches.sort(key=lambda m: m[0])
    return (matches[0][1] if matches else None), rejected


class AgentSession:
    """Bounded session-key client for 16ane x402 v2 purchases (REQ-003, REQ-006)."""

    def __init__(
        self,
        client: AneClient,
        vault_address: str,
        session_key: str | SecretKey,
    ) -> None:
        self.client = client
        self.vault_address = to_checksum_address(vault_address)
        self._session_key = (
            session_key if isinstance(session_key, SecretKey) else SecretKey(session_key)
        )
        self.session_address = private_key_to_address(self._session_key._unsafe_unwrap())
        self._vault_asset: Optional[str] = None

    def __repr__(self) -> str:
        return (
            f"AgentSession(vault={self.vault_address}, "
            f"session={self.session_address}, key={REDACTED_PRIVATE_KEY})"
        )

    def sign_spend_intent(
        self,
        merchant: str,
        amount: int | str,
        quote_id: str,
        service_id_hash: str,
        valid_before: int,
        nonce: Optional[str] = None,
        valid_after: int = 0,
        policy_version: int = 1,
    ) -> Dict[str, Any]:
        intent = {
            "vault": self.vault_address,
            "merchant": to_checksum_address(merchant),
            "amount": str(int(amount)),
            "quoteId": quote_id,
            "serviceIdHash": service_id_hash,
            "validAfter": valid_after,
            "validBefore": valid_before,
            "nonce": nonce or random_bytes32_hex(),
            "policyVersion": policy_version,
        }
        struct_hash, digest = hash_spend_intent(self.client.chain_id, intent)
        signature = sign_digest(digest, self._session_key._unsafe_unwrap())
        return {
            "intent": intent,
            "signature": signature,
            "intentId": struct_hash,
        }

    def sign_task_lock(
        self,
        escrow: str,
        amount: int | str,
        seller: str,
        deadline: int,
        spec_hash: str,
        service_id_hash: str,
        valid_before: int,
        nonce: Optional[str] = None,
    ) -> Dict[str, Any]:
        """Signs a lock of `amount` for an AneTaskEscrow task (#21). Nothing moves until someone submits
        it to the escrow's openTask; the vault then checks the signature and its whole policy."""
        seller = to_checksum_address(seller)
        signed = self.sign_spend_intent(
            merchant=escrow,
            amount=amount,
            quote_id=compute_task_quote_id(escrow, seller, deadline, spec_hash),
            service_id_hash=service_id_hash,
            valid_before=valid_before,
            nonce=nonce,
            policy_version=self.client.get_policy_version(self.vault_address),
        )
        intent = signed["intent"]
        signed["terms"] = {"seller": seller, "deadline": deadline, "specHash": spec_hash}
        signed["taskId"] = compute_payment_id(
            self.client.chain_id, intent["vault"], intent["merchant"], intent["quoteId"], intent["nonce"]
        )
        return signed

    def sign_task_release(
        self, escrow: str, task_id: str, cumulative_amount: int | str, delivery_hash: str
    ) -> str:
        """Signs a delivery receipt paying the seller up to `cumulative_amount` in total. The escrow
        accepts it only while this agent's delegation is active."""
        digest = hash_task_release(self.client.chain_id, escrow, task_id, cumulative_amount, delivery_hash)
        return sign_digest(digest, self._session_key._unsafe_unwrap())

    def vault_asset(self) -> str:
        """The one token this vault can pay in (`AneAgentVault.taneToken`), read once from the vault."""
        if self._vault_asset is None:
            out = self.client.eth_call(self.vault_address, _selector("taneToken()"))
            self._vault_asset = to_checksum_address("0x" + _split_words(out)[0][-40:])
        return self._vault_asset

    def purchase(
        self,
        url: str,
        method: str = "POST",
        body: Optional[str] = None,
        headers: Optional[Dict[str, str]] = None,
        max_payment: Optional[int] = None,
        idempotency_key: Optional[str] = None,
        verify_manifest: bool = False,
    ) -> Dict[str, Any]:
        idem_key = idempotency_key or f"idem-{random_bytes32_hex()[2:34]}"
        base_headers: Dict[str, str] = {
            "x-agent-vault": self.vault_address,
            "x-agent-session": self.session_address,
            "idempotency-key": idem_key,
        }
        if body is not None:
            base_headers["content-type"] = "application/json"
        if headers:
            base_headers.update(headers)

        def _do_request(req_headers: Dict[str, str]) -> Tuple[int, Dict[str, str], str]:
            req = urllib.request.Request(
                url,
                data=body.encode("utf-8") if body is not None else None,
                headers=req_headers,
                method=method.upper(),
            )
            try:
                with urllib.request.urlopen(req, timeout=15) as resp:
                    resp_headers = {k.lower(): v for k, v in resp.headers.items()}
                    return resp.status, resp_headers, resp.read().decode("utf-8")
            except urllib.error.HTTPError as err:
                with err:
                    resp_headers = {k.lower(): v for k, v in err.headers.items()}
                    return err.code, resp_headers, err.read().decode("utf-8")

        status, resp_headers, resp_text = _do_request(base_headers)
        if status != 402:
            data = json.loads(resp_text) if resp_text else {}
            receipt = None
            if "payment-response" in resp_headers:
                receipt = json.loads(
                    base64.b64decode(resp_headers["payment-response"]).decode("utf-8")
                )
            return {
                "status": status,
                "data": data,
                "receipt": receipt,
                "trialSponsored": bool(receipt and receipt.get("sponsored")),
            }

        payment_required_b64 = resp_headers.get("payment-required")
        if not payment_required_b64:
            raise RuntimeError("402 response missing PAYMENT-REQUIRED header")
        quote_envelope = json.loads(base64.b64decode(payment_required_b64).decode("utf-8"))
        vault_asset = self.vault_asset()
        req_item, rejected = select_vault_requirement(
            quote_envelope.get("accepts") if isinstance(quote_envelope, dict) else None,
            self.client.chain_id,
            vault_asset,
        )
        if req_item is None:
            raise RuntimeError(
                f"ANE-E-3003: No 402 quote is payable from this vault (tANE {vault_asset} on "
                f"eip155:{self.client.chain_id}): {'; '.join(rejected)}"
            )
        required_amount = int(req_item["amount"])

        if max_payment is not None and required_amount > int(max_payment):
            raise RuntimeError(
                f"ANE-E-3002: Quote amount {required_amount} exceeds max_payment {max_payment}"
            )

        if verify_manifest:
            parsed = urlparse(url)
            manifest_url = f"{parsed.scheme}://{parsed.netloc}/.well-known/16ane-service.json"
            with urllib.request.urlopen(manifest_url, timeout=10) as m_resp:
                manifest = json.loads(m_resp.read().decode("utf-8"))
            contracts = self.client.resolve_contracts()
            check = self.client.verify_service_manifest(
                manifest, contracts["aneServiceDirectory"]
            )
            if not check["valid"]:
                raise RuntimeError(f"ANE-E-5002: Invalid service manifest: {check.get('reason')}")
            if manifest["payTo"].lower() != req_item["payTo"].lower():
                raise RuntimeError("ANE-E-5003: Spoofed 402 payTo does not match signed manifest")

        summary = self.client.get_accounting_summary(self.vault_address)
        if not summary["active"] or summary["spendableNow"] < required_amount:
            raise RuntimeError(
                f"ANE-E-3001: Insufficient available session allowance ({summary['spendableNow']} < {required_amount})"
            )

        resource_hash = compute_resource_hash(method, url)
        request_hash = compute_request_hash(body)
        extra = req_item.get("extra") or {}
        quote_id_b32 = keccak256_utf8(
            f"{extra.get('quoteId', idem_key)}:{resource_hash}:{request_hash}"
        )
        service_id_hash = keccak256_utf8(
            extra.get("serviceId", "16ane-sandbox-reference-demo")
        )
        valid_before = int(
            extra.get("expiresAt") or (int(time.time()) + int(req_item.get("maxTimeoutSeconds", 300)))
        )

        signed = self.sign_spend_intent(
            merchant=req_item["payTo"],
            amount=required_amount,
            quote_id=quote_id_b32,
            service_id_hash=service_id_hash,
            valid_before=valid_before,
            policy_version=summary["policyVersion"],
        )
        payment_payload = {
            "x402Version": 2,
            "scheme": "ane-vault-v1",
            "network": req_item["network"],
            "accepted": {
                "asset": req_item["asset"],
                "amount": req_item["amount"],
                "payTo": req_item["payTo"],
            },
            "payload": {
                **signed["intent"],
                "resourceHash": resource_hash,
                "requestHash": request_hash,
                "signature": signed["signature"],
            },
        }
        payment_sig_b64 = base64.b64encode(json.dumps(payment_payload).encode("utf-8")).decode(
            "ascii"
        )
        paid_headers = {**base_headers, "payment-signature": payment_sig_b64}
        paid_status, paid_resp_headers, paid_text = _do_request(paid_headers)
        paid_data = json.loads(paid_text) if paid_text else {}
        receipt = None
        if "payment-response" in paid_resp_headers:
            receipt = json.loads(
                base64.b64decode(paid_resp_headers["payment-response"]).decode("utf-8")
            )
        return {
            "status": paid_status,
            "data": paid_data,
            "receipt": receipt,
            "trialSponsored": False,
        }
