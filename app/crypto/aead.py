from __future__ import annotations

import secrets
import struct
from pathlib import Path
from typing import Iterator

from cryptography.hazmat.primitives.ciphers.aead import AESGCM

MAGIC = b"FUPL"
_VERSION = b"\x01"
_PLAINTEXT_CHUNK = 2 * 1024 * 1024  # 2 MiB
_HEADER_SIZE = 21  # 4 + 1 + 12 + 4


def _nonce(base: bytes, idx: int, is_last: bool) -> bytes:
    delta = b"\x00" * 7 + struct.pack(">I", idx) + bytes([0x01 if is_last else 0x00])
    return bytes(a ^ b for a, b in zip(base, delta))


def _aad(idx: int, is_last: bool) -> bytes:
    return b"\x00" * 16 + struct.pack(">I", idx) + bytes([0x01 if is_last else 0x00])


def encrypt_file(key: bytes, src: Path, dst: Path) -> None:
    base_nonce = secrets.token_bytes(12)
    aesgcm = AESGCM(key)
    total = 0

    with open(src, "rb") as fin, open(dst, "w+b") as fout:
        fout.write(MAGIC + _VERSION + base_nonce + b"\x00\x00\x00\x00")

        buf = fin.read(_PLAINTEXT_CHUNK)
        while buf:
            nxt = fin.read(_PLAINTEXT_CHUNK)
            is_last = not nxt
            fout.write(aesgcm.encrypt(_nonce(base_nonce, total, is_last), buf, _aad(total, is_last)))
            total += 1
            buf = nxt

        if total == 0:
            fout.write(aesgcm.encrypt(_nonce(base_nonce, 0, True), b"", _aad(0, True)))
            total = 1

        fout.seek(17)
        fout.write(struct.pack(">I", total))


def decrypt_stream(key: bytes, path: Path) -> Iterator[bytes]:
    aesgcm = AESGCM(key)
    with open(path, "rb") as fh:
        if fh.read(4) != MAGIC:
            raise ValueError("not a FUPL file")
        if fh.read(1) != _VERSION:
            raise ValueError("unsupported version")
        base_nonce = fh.read(12)
        (total,) = struct.unpack(">I", fh.read(4))

        for idx in range(total):
            is_last = idx == total - 1
            ct = fh.read() if is_last else fh.read(_PLAINTEXT_CHUNK + 16)
            if ct is None or (not is_last and len(ct) < 16):
                raise ValueError(f"truncated at chunk {idx}")
            plaintext = aesgcm.decrypt(_nonce(base_nonce, idx, is_last), ct, _aad(idx, is_last))
            if plaintext:
                yield plaintext
