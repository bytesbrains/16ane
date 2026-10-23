import sys
import unittest
from pathlib import Path

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


if __name__ == "__main__":
    unittest.main()
