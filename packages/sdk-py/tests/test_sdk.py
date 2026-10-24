import base64
import io
import json
import sys
import unittest
import urllib.error
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from ane_sdk import (
    REDACTED_PRIVATE_KEY,
    AgentSession,
    AneClient,
    SecretKey,
    compute_payment_id,
    compute_request_hash,
    compute_resource_hash,
    compute_task_quote_id,
    hash_spend_intent,
    hash_task_release,
    keccak256_utf8,
    private_key_to_address,
    recover_address,
    redact_secrets,
    select_vault_requirement,
    sign_digest,
)


class TestAnePythonSdk(unittest.TestCase):
    def test_keccak256_and_ecdsa_parity(self) -> None:
        h = keccak256_utf8(
            "TransferWithAuthorization(address from,address to,uint256 value,uint256 validAfter,uint256 validBefore,bytes32 nonce)"
        )
        self.assertEqual(
            h,
            "0x7c7c6cdb67a18743f49ec6fa9b35f50d52ed05cbed4cc592e13b44501c1a2267",
        )
        priv = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80"
        addr = private_key_to_address(priv)
        self.assertEqual(addr, "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266")
        sig = sign_digest(h, priv)
        recovered = recover_address(h, sig)
        self.assertEqual(recovered, addr)

    def test_secret_key_redaction(self) -> None:
        raw = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80"
        sk = SecretKey(raw)
        self.assertEqual(str(sk), REDACTED_PRIVATE_KEY)
        self.assertIn(REDACTED_PRIVATE_KEY, repr(sk))
        self.assertNotIn("ac0974bec39a", str(sk))
        self.assertNotIn("ac0974bec39a", repr(sk))
        scrubbed = redact_secrets(f"failed with private_key={raw}", [raw])
        self.assertNotIn("ac0974bec39a", scrubbed)
        self.assertIn(REDACTED_PRIVATE_KEY, scrubbed)

    def test_spend_intent_signing(self) -> None:
        client = AneClient(rpc_url="http://127.0.0.1:8545", chain_id=84532)
        session = AgentSession(
            client=client,
            vault_address="0x1111111111111111111111111111111111111111",
            session_key=keccak256_utf8("16ane.test.session.key.v1"),
        )
        quote_id = compute_resource_hash("POST", "http://127.0.0.1:8787/v1/demo/summarize")
        service_id_hash = compute_request_hash("16ane-sandbox-reference-demo")
        signed = session.sign_spend_intent(
            merchant="0x70997970C51812dc3A010C7d01b50e0d17dc79C8",
            amount=16 * 10**18,
            quote_id=quote_id,
            service_id_hash=service_id_hash,
            valid_before=1900000000,
            nonce="0x" + "ab" * 32,
            policy_version=1,
        )
        _, digest = hash_spend_intent(84532, signed["intent"])
        recovered = recover_address(digest, signed["signature"])
        self.assertEqual(recovered, session.session_address)


    def test_task_escrow_hashes_match_the_typescript_sdk(self) -> None:
        # Vectors from packages/sdk-ts (computeTaskQuoteId, computeTaskId, hashTaskRelease), which the
        # e2e flow checks against the deployed AneTaskEscrow (#21).
        escrow = "0x" + "e5" * 20
        quote_id = compute_task_quote_id(
            escrow, "0x" + "5e" * 20, 1700259200, keccak256_utf8("translate 40 pages; task 1")
        )
        self.assertEqual(
            quote_id, "0xff0ff7737ed1727408e3eeee855359e37d4e1da616e62ddf0c76e8d57c455203"
        )
        task_id = compute_payment_id(84532, "0x" + "77" * 20, escrow, quote_id, "0x" + "01" * 32)
        self.assertEqual(
            task_id, "0xe7b57b8488858c1abc3f7d8b1a3608121f09ea3c1b65a2cadb63213e2130a0c7"
        )
        digest = hash_task_release(84532, escrow, task_id, 40 * 10**18, keccak256_utf8("chapter 1"))
        self.assertEqual(
            digest, "0xb2932d2e43812e79699c61557bf29aa322184eb1a9bc235dcdd3f9a317ea3f3c"
        )

    def test_task_lock_and_receipt_signing(self) -> None:
        class FakeClient(AneClient):
            def get_policy_version(self, vault_address: str) -> int:
                return 4

        client = FakeClient(rpc_url="http://127.0.0.1:8545", chain_id=84532)
        session = AgentSession(
            client=client,
            vault_address="0x" + "77" * 20,
            session_key=keccak256_utf8("16ane.test.session.key.v1"),
        )
        escrow = "0x" + "e5" * 20
        spec = keccak256_utf8("translate 40 pages; task 1")
        lock = session.sign_task_lock(
            escrow=escrow,
            amount=100 * 10**18,
            seller="0x" + "5e" * 20,
            deadline=1700259200,
            spec_hash=spec,
            service_id_hash=keccak256_utf8("translation"),
            valid_before=1700003600,
            nonce="0x" + "01" * 32,
        )
        intent = lock["intent"]
        self.assertEqual(intent["merchant"].lower(), escrow)
        self.assertEqual(intent["policyVersion"], 4)
        self.assertEqual(intent["quoteId"], compute_task_quote_id(escrow, "0x" + "5e" * 20, 1700259200, spec))
        _, digest = hash_spend_intent(84532, intent)
        self.assertEqual(recover_address(digest, lock["signature"]), session.session_address)

        receipt = session.sign_task_release(escrow, lock["taskId"], 40 * 10**18, keccak256_utf8("d"))
        release_digest = hash_task_release(84532, escrow, lock["taskId"], 40 * 10**18, keccak256_utf8("d"))
        self.assertEqual(recover_address(release_digest, receipt), session.session_address)


TANE = "0x" + "a1" * 20
USDC = "0x" + "b2" * 20


def _quote(**over):
    q = {"scheme": "ane-vault-v1", "network": "eip155:84532", "asset": TANE, "amount": str(16 * 10**18), "payTo": "0x" + "c3" * 20}
    q.update(over)
    return q


class TestVaultQuoteSelection(unittest.TestCase):
    """ADR-0019: the vault pays only its own token on its own chain; parity with the TypeScript SDK."""

    def test_only_the_vault_token_on_this_chain_is_payable(self) -> None:
        picked, rejected = select_vault_requirement(
            [_quote(asset=USDC, amount="1"), _quote(amount=str(9 * 10**18)), _quote(amount=str(7 * 10**18)), _quote(network="eip155:1")],
            84532,
            TANE,
        )
        self.assertEqual(picked["amount"], str(7 * 10**18))
        self.assertEqual(len(rejected), 2)
        self.assertIn("is not accepted", rejected[0])
        self.assertIn('on "eip155:1"', rejected[1])

    def test_untrusted_amount_and_scheme_encodings_are_refused(self) -> None:
        for amount in ["1e18", "-1", "0x10", "1.0", " 16", "016", 16, str(2**256), "\u0661"]:
            picked, rejected = select_vault_requirement([_quote(amount=amount)], 84532, TANE)
            self.assertIsNone(picked, amount)
            self.assertEqual(rejected, ["amount is not a base-unit integer"])
        picked, rejected = select_vault_requirement([_quote(scheme="x" * 500)], 84532, TANE)
        self.assertIsNone(picked)
        self.assertLess(len(rejected[0]), 80)
        self.assertEqual(select_vault_requirement("junk", 84532, TANE), (None, ["no payment options offered"]))

    def test_purchase_refuses_a_foreign_asset_quote_before_signing(self) -> None:
        client = AneClient(rpc_url="http://127.0.0.1:1", chain_id=84532)
        client.eth_call = lambda to, data: "0x" + TANE[2:].rjust(64, "0")
        session = AgentSession(client, "0x" + "ee" * 20, "0x" + "11" * 32)
        envelope = base64.b64encode(json.dumps({"x402Version": 2, "accepts": [_quote(asset=USDC, amount="1")]}).encode()).decode()
        calls = []

        def fake_urlopen(req, timeout=0):
            calls.append(req)
            raise urllib.error.HTTPError(req.full_url, 402, "Payment Required", {"payment-required": envelope}, io.BytesIO(b"{}"))

        with mock.patch("urllib.request.urlopen", fake_urlopen):
            with self.assertRaisesRegex(RuntimeError, "ANE-E-3003"):
                session.purchase("https://a.example/v1/infer", body="{}", max_payment=100 * 10**18)
        self.assertEqual(len(calls), 1)
        self.assertNotIn("payment-signature", {k.lower() for k in calls[0].headers})


if __name__ == "__main__":
    unittest.main()
