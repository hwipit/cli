#!/usr/bin/env python3
"""Vectors for the chunked sealed-file format (src/file-crypto.ts, `file-chunk-v1`).

Independent of every consumer: only `cryptography`'s AESGCM and hashlib. Run
`python3 scripts/gen-file-chunk-vectors.py > src/file-chunk.vectors.json`; the
iOS app keeps a copy of the output and seals to the same bytes.

Format: the (already padded) plaintext is cut into `chunk`-byte pieces, the
last one shorter or equal and never empty. Piece i is sealed alone with
AES-256-GCM under the file key, no AAD, and the nonce
    prefix[7] || i as 4 bytes big-endian || 0x01 on the last piece, else 0x00
and the file is every `ciphertext || tag[16]` in order.
"""
import hashlib
import json
import sys

from cryptography.hazmat.primitives.ciphers.aead import AESGCM

TAG = 16


def pattern(length: int) -> bytes:
    """Plaintext a consumer can rebuild without the vectors carrying megabytes."""
    return bytes((i * 31 + 7) & 0xFF for i in range(length))


def nonce(prefix: bytes, index: int, last: bool) -> bytes:
    return prefix + index.to_bytes(4, "big") + (b"\x01" if last else b"\x00")


def seal(key: bytes, prefix: bytes, chunk: int, plain: bytes) -> list[bytes]:
    pieces = [plain[i:i + chunk] for i in range(0, len(plain), chunk)]
    aes = AESGCM(key)
    return [aes.encrypt(nonce(prefix, i, i == len(pieces) - 1), piece, None) for i, piece in enumerate(pieces)]


def case(name: str, seed: int, chunk: int, length: int) -> tuple[dict, list[bytes], bytes, bytes]:
    key = hashlib.sha256(b"file-chunk-v1 key %d" % seed).digest()
    prefix = hashlib.sha256(b"file-chunk-v1 prefix %d" % seed).digest()[:7]
    plain = pattern(length)
    sealed = seal(key, prefix, chunk, plain)
    whole = b"".join(sealed)
    out = {
        "name": name,
        "key": key.hex(),
        "prefix": prefix.hex(),
        "chunk": chunk,
        "plainLength": length,
        "plainSha256": hashlib.sha256(plain).hexdigest(),
        "sealedLength": len(whole),
        "sealedSha256": hashlib.sha256(whole).hexdigest(),
    }
    if len(whole) <= 4096:
        out["sealed"] = whole.hex()
    return out, sealed, key, prefix


def main() -> None:
    mib = 1_048_576
    cases = [
        case("one short piece", 1, 16, 5),
        case("one full piece", 2, 16, 16),
        case("a full piece and one byte", 3, 16, 17),
        case("three pieces, the last short", 4, 16, 40),
        case("three full pieces", 5, 16, 48),
        case("1 MiB pieces: under one", 6, mib, mib - 1),
        case("1 MiB pieces: exactly one", 7, mib, mib),
        case("1 MiB pieces: one and a byte", 8, mib, mib + 1),
        case("1 MiB pieces: three and a bit", 9, mib, 3 * mib + 12345),
    ]

    # What a reader must refuse, each made from the "three pieces, the last short" case.
    base, sealed, key, prefix = cases[3]
    flipped = bytearray(b"".join(sealed))
    flipped[20] ^= 0x01
    # A file cut at a piece boundary, its new end re-sealed by no one: the last piece left says "not last".
    refused = [
        {"name": "two pieces swapped", "sealed": (sealed[1] + sealed[0] + sealed[2]).hex()},
        {"name": "the last piece cut off", "sealed": (sealed[0] + sealed[1]).hex()},
        {"name": "the last piece cut short by a byte", "sealed": b"".join(sealed)[:-1].hex()},
        {"name": "a piece repeated", "sealed": (sealed[0] + sealed[0] + sealed[1] + sealed[2]).hex()},
        {"name": "bytes after the last piece", "sealed": (b"".join(sealed) + sealed[2]).hex()},
        {"name": "one more byte after the last piece", "sealed": (b"".join(sealed) + b"\x00").hex()},
        {"name": "a bit flipped", "sealed": bytes(flipped).hex()},
        {"name": "nothing at all", "sealed": ""},
        {"name": "only a tag (an empty piece)", "sealed": AESGCM(key).encrypt(nonce(prefix, 0, True), b"", None).hex()},
    ]
    json.dump({
        "info": "file-chunk-v1: plaintext cut into `chunk`-byte pieces, each AES-256-GCM sealed alone; "
                "nonce = prefix[7] || index u32 big-endian || last flag; file = every ciphertext||tag in order",
        "generatedBy": "scripts/gen-file-chunk-vectors.py — python cryptography AESGCM + hashlib (independent of every consumer)",
        "plain": "byte i of the plaintext is (i * 31 + 7) & 0xff",
        "cases": [c[0] for c in cases],
        "refused": {"key": base["key"], "prefix": base["prefix"], "chunk": base["chunk"], "cases": refused},
    }, sys.stdout, indent=2)
    sys.stdout.write("\n")


if __name__ == "__main__":
    main()
