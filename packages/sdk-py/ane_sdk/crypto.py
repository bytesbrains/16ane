"""Pure-Python Keccak-256, secp256k1 ECDSA (RFC 6979), and EIP-712 utilities for ane_sdk."""

from __future__ import annotations

import hashlib
import hmac
import secrets
from typing import Any, Dict, List, Optional, Tuple
from urllib.parse import urlparse

# ============================================================================
# 1. Pure Keccak-256 (Ethereum 0x01 padding)
# ============================================================================

KECCAK_ROUNDS = 24
ROTC = [
    1, 3, 6, 10, 15, 21, 28, 36, 45, 55, 2, 14, 27, 41, 56, 8, 25, 43, 62, 18, 39, 61, 20, 44,
]
PILN = [
    10, 7, 11, 17, 18, 3, 5, 16, 8, 21, 24, 4, 15, 23, 19, 13, 12, 2, 20, 14, 22, 9, 6, 1,
]
RC = [
    0x0000000000000001, 0x0000000000008082, 0x800000000000808A, 0x8000000080008000,
    0x000000000000808B, 0x0000000080000001, 0x8000000080008081, 0x8000000000008009,
    0x000000000000008A, 0x0000000000000088, 0x0000000080008009, 0x000000008000000A,
    0x000000008000808B, 0x800000000000008B, 0x8000000000008089, 0x8000000000008003,
    0x8000000000008002, 0x8000000000000080, 0x000000000000800A, 0x800000008000000A,
    0x8000000080008081, 0x8000000000008080, 0x0000000080000001, 0x8000000080008008,
]
MASK_64 = 0xFFFFFFFFFFFFFFFF


def _rotl64(x: int, n: int) -> int:
    return ((x << n) | (x >> (64 - n))) & MASK_64


def _keccak_f1600(state: List[int]) -> None:
    bc = [0] * 5
    for r in range(KECCAK_ROUNDS):
        for i in range(5):
            bc[i] = state[i] ^ state[i + 5] ^ state[i + 10] ^ state[i + 15] ^ state[i + 20]
        for i in range(5):
            t = bc[(i + 4) % 5] ^ _rotl64(bc[(i + 1) % 5], 1)
            for j in range(0, 25, 5):
                state[j + i] = (state[j + i] ^ t) & MASK_64
        t = state[1]
        for i in range(24):
            j = PILN[i]
            state[j], t = _rotl64(t, ROTC[i]), state[j]
        for j in range(0, 25, 5):
            for i in range(5):
                bc[i] = state[j + i]
            for i in range(5):
                state[j + i] = (bc[i] ^ ((~bc[(i + 1) % 5]) & bc[(i + 2) % 5])) & MASK_64
        state[0] = (state[0] ^ RC[r]) & MASK_64


def keccak256_bytes(data: bytes) -> bytes:
    rate = 136
    state = [0] * 25
    padded_len = ((len(data) + rate) // rate) * rate
    buf = bytearray(padded_len)
    buf[: len(data)] = data
    buf[len(data)] ^= 0x01
    buf[padded_len - 1] ^= 0x80

    for offset in range(0, padded_len, rate):
        for i in range(rate // 8):
            lane = int.from_bytes(buf[offset + i * 8 : offset + (i + 1) * 8], "little")
            state[i] = (state[i] ^ lane) & MASK_64
        _keccak_f1600(state)

    out = bytearray(32)
    for i in range(4):
        out[i * 8 : (i + 1) * 8] = state[i].to_bytes(8, "little")
    return bytes(out)


def keccak256(data: bytes | str) -> str:
    if isinstance(data, str):
        if data.startswith(("0x", "0X")):
            raw = bytes.fromhex(data[2:])
        else:
            raw = data.encode("utf-8")
    else:
        raw = data
    return "0x" + keccak256_bytes(raw).hex()


def keccak256_utf8(text: str) -> str:
    return "0x" + keccak256_bytes(text.encode("utf-8")).hex()


# ============================================================================
# 2. Pure secp256k1 ECDSA (RFC 6979 + EIP-2 low-S + Recovery)
# ============================================================================

SECP_P = 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEFFFFFC2F
SECP_N = 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141
SECP_HALF_N = SECP_N >> 1
SECP_GX = 0x79BE667EF9DCBBAC55A06295CE870B07029BFCDB2DCE28D959F2815B16F81798
SECP_GY = 0x483ADA7726A3C4655DA4FBFC0E1108A8FD17B448A68554199C47D08FFB10D4B8

Point = Optional[Tuple[int, int]]


def _mod_inv(a: int, m: int = SECP_P) -> int:
    return pow(a % m, -1, m)


def _point_add(p1: Point, p2: Point) -> Point:
    if p1 is None:
        return p2
    if p2 is None:
        return p1
    x1, y1 = p1
    x2, y2 = p2
    if x1 == x2 and y1 != y2:
        return None
    if x1 == x2:
        lam = (3 * x1 * x1 * _mod_inv(2 * y1, SECP_P)) % SECP_P
    else:
        lam = ((y2 - y1) * _mod_inv(x2 - x1, SECP_P)) % SECP_P
    x3 = (lam * lam - x1 - x2) % SECP_P
    y3 = (lam * (x1 - x3) - y1) % SECP_P
    return (x3, y3)


def _point_mul(k: int, p: Tuple[int, int] = (SECP_GX, SECP_GY)) -> Tuple[int, int]:
    scalar = k % SECP_N
    if scalar == 0:
        raise ValueError("Invalid zero scalar")
    result: Point = None
    addend: Point = p
    while scalar > 0:
        if scalar & 1:
            result = _point_add(result, addend)
        addend = _point_add(addend, addend)
        scalar >>= 1
    if result is None:
        raise ValueError("Point at infinity")
    return result


def _rfc6979_nonce(msg_hash: bytes, priv_int: int) -> int:
    x = priv_int.to_bytes(32, "big")
    h1 = (int.from_bytes(msg_hash, "big") % SECP_N).to_bytes(32, "big")
    v = b"\x01" * 32
    k = b"\x00" * 32
    k = hmac.new(k, v + b"\x00" + x + h1, hashlib.sha256).digest()
    v = hmac.new(k, v, hashlib.sha256).digest()
    k = hmac.new(k, v + b"\x01" + x + h1, hashlib.sha256).digest()
    v = hmac.new(k, v, hashlib.sha256).digest()
    while True:
        v = hmac.new(k, v, hashlib.sha256).digest()
        candidate = int.from_bytes(v, "big")
        if 1 <= candidate < SECP_N:
            return candidate
        k = hmac.new(k, v + b"\x00", hashlib.sha256).digest()
        v = hmac.new(k, v, hashlib.sha256).digest()


def to_checksum_address(address: str) -> str:
    clean = address.strip().lower()
    if clean.startswith("0x"):
        clean = clean[2:]
    if len(clean) != 40:
        raise ValueError(f"Invalid EVM address: {address}")
    digest = keccak256_utf8(clean)[2:]
    out = ["0x"]
    for i, ch in enumerate(clean):
        out.append(ch.upper() if int(digest[i], 16) >= 8 else ch)
    return "".join(out)


def private_key_to_address(private_key_hex: str) -> str:
    clean = private_key_hex.strip().lower()
    if clean.startswith("0x"):
        clean = clean[2:]
    priv = int(clean, 16)
    px, py = _point_mul(priv)
    pub_bytes = px.to_bytes(32, "big") + py.to_bytes(32, "big")
    addr_hex = keccak256_bytes(pub_bytes).hex()[-40:]
    return to_checksum_address("0x" + addr_hex)


def sign_digest(digest_hex: str, private_key_hex: str) -> str:
    clean_key = private_key_hex.strip().lower()
    if clean_key.startswith("0x"):
        clean_key = clean_key[2:]
    priv = int(clean_key, 16)
    clean_digest = digest_hex[2:] if digest_hex.startswith(("0x", "0X")) else digest_hex
    digest_bytes = bytes.fromhex(clean_digest)
    if len(digest_bytes) != 32:
        raise ValueError("Digest must be 32 bytes")

    z = int.from_bytes(digest_bytes, "big") % SECP_N
    k = _rfc6979_nonce(digest_bytes, priv)
    rx, ry = _point_mul(k)
    r = rx % SECP_N
    s = (_mod_inv(k, SECP_N) * (z + r * priv)) % SECP_N
    recid = ry & 1
    if s > SECP_HALF_N:
        s = SECP_N - s
        recid ^= 1
    v = 27 + recid
    return f"0x{r:064x}{s:064x}{v:02x}"


def recover_address(digest_hex: str, signature_hex: str) -> str:
    clean_sig = signature_hex[2:] if signature_hex.startswith(("0x", "0X")) else signature_hex
    sig_bytes = bytes.fromhex(clean_sig)
    if len(sig_bytes) != 65:
        raise ValueError("Signature must be 65 bytes")
    r = int.from_bytes(sig_bytes[0:32], "big")
    s = int.from_bytes(sig_bytes[32:64], "big")
    v = sig_bytes[64]
    if v >= 27:
        v -= 27
    if v not in (0, 1) or not (1 <= r < SECP_N) or not (1 <= s <= SECP_HALF_N):
        raise ValueError("Invalid ECDSA signature parameters")

    x = r
    y_cubed = (pow(x, 3, SECP_P) + 7) % SECP_P
    y = pow(y_cubed, (SECP_P + 1) // 4, SECP_P)
    if (y * y) % SECP_P != y_cubed:
        raise ValueError("Point not on curve")
    if (y & 1) != v:
        y = SECP_P - y

    clean_digest = digest_hex[2:] if digest_hex.startswith(("0x", "0X")) else digest_hex
    z = int(clean_digest, 16) % SECP_N
    r_inv = _mod_inv(r, SECP_N)
    u1 = (SECP_N - ((z * r_inv) % SECP_N)) % SECP_N
    u2 = (s * r_inv) % SECP_N
    q = _point_add(
        None if u1 == 0 else _point_mul(u1),
        None if u2 == 0 else _point_mul(u2, (x, y)),
    )
    if q is None:
        raise ValueError("Recovered point at infinity")
    pub_bytes = q[0].to_bytes(32, "big") + q[1].to_bytes(32, "big")
    return to_checksum_address("0x" + keccak256_bytes(pub_bytes).hex()[-40:])


# ============================================================================
# 3. ABI Word Encoding & EIP-712 Hashing
# ============================================================================


def abi_word_uint(value: int | str) -> str:
    n = int(value)
    if n < 0:
        raise ValueError("Unsigned int cannot be negative")
    return f"{n:064x}"


def abi_word_address(address: str) -> str:
    clean = address.strip().lower()
    if clean.startswith("0x"):
        clean = clean[2:]
    if len(clean) != 40:
        raise ValueError(f"Invalid address: {address}")
    return clean.rjust(64, "0")


def abi_word_bytes32(b32: str) -> str:
    clean = b32.strip().lower()
    if clean.startswith("0x"):
        clean = clean[2:]
    if len(clean) != 64:
        raise ValueError(f"Invalid bytes32: {b32}")
    return clean


EIP712_DOMAIN_TYPEHASH = keccak256_utf8(
    "EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"
)
SPEND_INTENT_TYPEHASH = keccak256_utf8(
    "SpendIntent(address vault,address merchant,uint256 amount,bytes32 quoteId,bytes32 serviceIdHash,uint256 validAfter,uint256 validBefore,bytes32 nonce,uint64 policyVersion)"
)
SERVICE_MANIFEST_TYPEHASH = keccak256_utf8(
    "ServiceManifest(string serviceId,string version,uint256 chainId,address payTo,address tokenAddress,bytes32 endpointsHash,uint64 updatedAt)"
)


def hash_eip712_domain(name: str, version: str, chain_id: int, verifying_contract: str) -> str:
    encoded = (
        "0x"
        + abi_word_bytes32(EIP712_DOMAIN_TYPEHASH)
        + abi_word_bytes32(keccak256_utf8(name))
        + abi_word_bytes32(keccak256_utf8(version))
        + abi_word_uint(chain_id)
        + abi_word_address(verifying_contract)
    )
    return keccak256(encoded)


def hash_spend_intent(chain_id: int, intent: Dict[str, Any]) -> Tuple[str, str]:
    domain = hash_eip712_domain("AneAgentVault", "1", chain_id, intent["vault"])
    struct_hash = keccak256(
        "0x"
        + abi_word_bytes32(SPEND_INTENT_TYPEHASH)
        + abi_word_address(intent["vault"])
        + abi_word_address(intent["merchant"])
        + abi_word_uint(intent["amount"])
        + abi_word_bytes32(intent["quoteId"])
        + abi_word_bytes32(intent["serviceIdHash"])
        + abi_word_uint(intent.get("validAfter", 0))
        + abi_word_uint(intent["validBefore"])
        + abi_word_bytes32(intent["nonce"])
        + abi_word_uint(intent.get("policyVersion", 1))
    )
    digest = keccak256("0x1901" + abi_word_bytes32(domain) + abi_word_bytes32(struct_hash))
    return struct_hash, digest


def hash_service_manifest(
    manifest: Dict[str, Any],
    verifying_directory: str = "0x0000000000000000000000000000000000000000",
) -> Tuple[str, str]:
    canonical_eps = "|".join(
        f"{e['id']}:{e['method']}:{e['path']}:{e['priceAmount']}:{e['scheme']}"
        for e in manifest["endpoints"]
    )
    endpoints_hash = keccak256_utf8(canonical_eps)
    domain = hash_eip712_domain(
        "16ane.ServiceManifest", "1", int(manifest["chainId"]), verifying_directory
    )
    struct_hash = keccak256(
        "0x"
        + abi_word_bytes32(SERVICE_MANIFEST_TYPEHASH)
        + abi_word_bytes32(keccak256_utf8(manifest["serviceId"]))
        + abi_word_bytes32(keccak256_utf8(manifest["version"]))
        + abi_word_uint(manifest["chainId"])
        + abi_word_address(manifest["payTo"])
        + abi_word_address(manifest["tokenAddress"])
        + abi_word_bytes32(endpoints_hash)
        + abi_word_uint(manifest["updatedAt"])
    )
    digest = keccak256("0x1901" + abi_word_bytes32(domain) + abi_word_bytes32(struct_hash))
    return struct_hash, digest


def compute_resource_hash(method: str, canonical_url: str) -> str:
    parsed = urlparse(canonical_url)
    origin = f"{parsed.scheme.lower()}://{parsed.netloc.lower()}"
    query = f"?{parsed.query}" if parsed.query else ""
    normalized = f"{method.upper()}:{origin}{parsed.path}{query}"
    return keccak256_utf8(normalized)


def compute_request_hash(body: Optional[str | bytes] = None) -> str:
    if not body:
        return keccak256_utf8("")
    if isinstance(body, str):
        return keccak256_utf8(body)
    return keccak256(body)


def random_bytes32_hex() -> str:
    return "0x" + secrets.token_hex(32)
