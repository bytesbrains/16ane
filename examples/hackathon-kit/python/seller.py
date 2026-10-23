"""A seller agent in Python (#20): POST /v1/digits writes the digits in a text in Devanagari
(2024 -> २०२४), priced at 8 tANE.

It speaks x402 v2. A request without payment gets 402 and a quote. A paid request is checked
here (payee, price, and that the signed payment is for THIS method, URL and body), then handed
to an x402 facilitator's /settle, which verifies the signature and settles on-chain. The Python
SDK never sends transactions, so this seller needs no gas: the facilitator pays it.

    python3 examples/hackathon-kit/python/seller.py              # http://127.0.0.1:9102/v1/digits
    PORT=9200 python3 examples/hackathon-kit/python/seller.py

The local sandbox starts a facilitator for you. On the public sandbox, run your own
(docs/operations/SELF_HOSTING.md) and set FACILITATOR_URL. Keep the disclaimer in every response.
"""

from __future__ import annotations

import base64
import json
import os
import sys
import threading
import time
import urllib.error
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from kit import (
    ONE_TANE,
    SANDBOX_DISCLAIMER,
    address_of,
    client_for,
    compute_request_hash,
    compute_resource_hash,
    load_or_create_key,
    random_bytes32_hex,
    read_network,
    tane,
)

SERVICE_ID = "hackathon-devanagari-digits"
PATH = "/v1/digits"
PRICE = 8 * ONE_TANE
DEVANAGARI = str.maketrans("0123456789", "०१२३४५६७८९")


def work(payload: dict) -> dict:
    """The service itself: deterministic, cheap and free of real compute."""
    text = payload.get("text") if isinstance(payload.get("text"), str) else ""
    return {"text": text.translate(DEVANAGARI)}


def b64json(value: dict) -> str:
    return base64.b64encode(json.dumps(value).encode("utf-8")).decode("ascii")


class Seller:
    def __init__(self) -> None:
        self.net = read_network()
        self.facilitator = os.environ.get("FACILITATOR_URL") or self.net.get("facilitatorUrl")
        if not self.facilitator:
            sys.exit("Set FACILITATOR_URL to an x402 facilitator (the local sandbox starts one for you).")
        self.pay_to = address_of(load_or_create_key("seller-py"))
        self.asset = client_for(self.net).resolve_contracts()["aneTestToken"]
        self.network = f"eip155:{self.net['chainId']}"
        self.answers: dict[str, tuple[str, int, dict, dict]] = {}  # idempotency key -> first answer
        self.lock = threading.Lock()

    def requirements(self, url: str) -> dict:
        return {
            "scheme": "ane-vault-v1",
            "network": self.network,
            "asset": self.asset,
            "assetSymbol": "tANE",
            "amount": str(PRICE),
            "payTo": self.pay_to,
            "maxTimeoutSeconds": 300,
            "resource": url,
            "description": "Writes digits in Devanagari",
        }

    def quote(self, url: str) -> tuple[int, dict, dict]:
        requirement = self.requirements(url)
        requirement["extra"] = {
            "quoteId": "quote_" + random_bytes32_hex()[2:26],
            "expiresAt": int(time.time()) + 300,
            "serviceId": SERVICE_ID,
            "trialAvailable": False,
            "disclaimer": SANDBOX_DISCLAIMER,
        }
        envelope = {"x402Version": 2, "accepts": [requirement], "error": "Payment Required"}
        body = {"error": {"code": "ANE-E-4002", "message": f"Pay {tane(PRICE)} to use {PATH}"}}
        return 402, body, {"payment-required": b64json(envelope)}

    def settle(self, url: str, raw_body: str, header: str) -> tuple[int, dict, dict]:
        try:
            decoded = json.loads(base64.b64decode(header))
            payload = decoded["payload"]
        except (ValueError, KeyError, TypeError):
            return 400, {"error": {"code": "ANE-E-4001", "message": "Malformed PAYMENT-SIGNATURE header"}}, {}
        # Bind the payment to this request, so a payment for one call can't be replayed on another.
        if payload.get("resourceHash", "").lower() != compute_resource_hash("POST", url).lower() or payload.get(
            "requestHash", ""
        ).lower() != compute_request_hash(raw_body).lower():
            return 400, {"error": {"code": "ANE-E-4006", "message": "Payment is for a different request"}}, {}
        if payload.get("merchant", "").lower() != self.pay_to.lower() or int(payload.get("amount", 0)) < PRICE:
            return 402, {"error": {"code": "ANE-E-4008", "message": f"Pay {tane(PRICE)} to {self.pay_to}"}}, {}

        requirements = self.requirements(url)
        request = {
            "x402Version": 2,
            "paymentPayload": {
                "x402Version": 2,
                "accepted": {k: requirements[k] for k in ("scheme", "network", "asset", "amount", "payTo")},
                "payload": payload,
            },
            "paymentRequirements": {k: requirements[k] for k in ("scheme", "network", "asset", "amount", "payTo", "maxTimeoutSeconds")},
        }
        req = urllib.request.Request(
            f"{self.facilitator}/settle",
            data=json.dumps(request).encode("utf-8"),
            headers={"content-type": "application/json"},
            method="POST",
        )
        try:
            with urllib.request.urlopen(req, timeout=60) as resp:
                result = json.loads(resp.read())
        except urllib.error.HTTPError as err:
            result = json.loads(err.read() or b"{}")
        if not result.get("success"):
            message = result.get("errorMessage", "settlement failed")
            return 402, {"error": {"code": result.get("errorReason", "ANE-E-4009"), "message": message}}, {}

        receipt = result["extra"]["receipt"]
        body = {
            "serviceId": SERVICE_ID,
            **work(json.loads(raw_body or "{}")),
            "paid": tane(receipt["amount"]),
            "txHash": result["transaction"],
            "disclaimer": SANDBOX_DISCLAIMER,
        }
        return 200, body, {"payment-response": b64json(receipt)}


def make_handler(seller: Seller) -> type[BaseHTTPRequestHandler]:
    class Handler(BaseHTTPRequestHandler):
        def send(self, status: int, body: dict, headers: dict) -> None:
            data = json.dumps(body, ensure_ascii=False).encode("utf-8")
            self.send_response(status)
            self.send_header("content-type", "application/json; charset=utf-8")
            for name, value in headers.items():
                self.send_header(name, value)
            self.send_header("content-length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)

        def do_POST(self) -> None:
            if self.path != PATH:
                self.send(404, {"error": f"try POST {PATH}", "disclaimer": SANDBOX_DISCLAIMER}, {})
                return
            length = int(self.headers.get("content-length") or 0)
            if length > 64 * 1024:
                self.send(413, {"error": "body too large"}, {})
                return
            raw_body = self.rfile.read(length).decode("utf-8")
            url = f"http://{self.headers.get('host', '127.0.0.1')}{self.path}"
            key = self.headers.get("idempotency-key")
            request_hash = compute_request_hash(raw_body)

            # A retry with the same Idempotency-Key gets the first answer back and is never charged twice.
            with seller.lock:
                cached = seller.answers.get(key) if key else None
            if cached:
                if cached[0] != request_hash:
                    self.send(409, {"error": {"code": "ANE-E-4004", "message": "Idempotency-Key reused"}}, {})
                else:
                    self.send(cached[1], cached[2], cached[3])
                return

            header = self.headers.get("payment-signature")
            status, body, headers = seller.settle(url, raw_body, header) if header else seller.quote(url)
            if status == 200 and key:
                with seller.lock:
                    seller.answers[key] = (request_hash, status, body, headers)
            self.send(status, body, headers)

        def log_message(self, fmt: str, *args: object) -> None:
            sys.stderr.write(f"seller.py: {fmt % args}\n")

    return Handler


def main() -> None:
    seller = Seller()
    server = ThreadingHTTPServer(("127.0.0.1", int(os.environ.get("PORT", "9102"))), make_handler(seller))
    url = f"http://127.0.0.1:{server.server_address[1]}{PATH}"
    print(f"Seller (Python) on {url}: {tane(PRICE)} per call, paid to {seller.pay_to}. {SANDBOX_DISCLAIMER}", flush=True)
    server.serve_forever()


if __name__ == "__main__":
    main()
