from __future__ import annotations

import os

from cryptography.hazmat.primitives.ciphers.aead import AESGCM

IV_LEN = 12


def seal(key: bytes, plaintext: bytes, aad: bytes = b"") -> bytes:
    """Encrypt with AES-256-GCM under a fresh random 12-byte IV.

    Returns iv || ciphertext || tag. The IV is generated per call and never
    reused. `aad` is authenticated but not encrypted.
    """
    iv = os.urandom(IV_LEN)
    ct = AESGCM(key).encrypt(iv, plaintext, aad)
    return iv + ct


def open_box(key: bytes, blob: bytes, aad: bytes = b"") -> bytes:
    """Inverse of seal(). Raises cryptography InvalidTag on tamper/wrong key."""
    iv, ct = blob[:IV_LEN], blob[IV_LEN:]
    return AESGCM(key).decrypt(iv, ct, aad)
