from __future__ import annotations

import secrets
from pathlib import Path

import pytest

from app.crypto.aead import decrypt_stream, encrypt_file, MAGIC


def test_encrypt_produces_fupl_header(tmp_path):
    key = secrets.token_bytes(32)
    src = tmp_path / "plain.bin"
    dst = tmp_path / "enc.fupl"
    src.write_bytes(b"hello world")
    encrypt_file(key, src, dst)
    data = dst.read_bytes()
    assert data[:4] == MAGIC
    assert data[4:5] == b"\x01"


def test_roundtrip_small(tmp_path):
    key = secrets.token_bytes(32)
    src = tmp_path / "plain.bin"
    dst = tmp_path / "enc.fupl"
    plaintext = b"The quick brown fox jumps over the lazy dog"
    src.write_bytes(plaintext)
    encrypt_file(key, src, dst)
    recovered = b"".join(decrypt_stream(key, dst))
    assert recovered == plaintext


def test_roundtrip_multi_chunk(tmp_path):
    key = secrets.token_bytes(32)
    src = tmp_path / "big.bin"
    dst = tmp_path / "big.fupl"
    plaintext = secrets.token_bytes(5 * 1024 * 1024)  # 5 MiB → 3 chunks
    src.write_bytes(plaintext)
    encrypt_file(key, src, dst)
    recovered = b"".join(decrypt_stream(key, dst))
    assert recovered == plaintext


def test_wrong_key_raises(tmp_path):
    key = secrets.token_bytes(32)
    wrong_key = secrets.token_bytes(32)
    src = tmp_path / "plain.bin"
    dst = tmp_path / "enc.fupl"
    src.write_bytes(b"secret data")
    encrypt_file(key, src, dst)
    with pytest.raises(Exception):
        list(decrypt_stream(wrong_key, dst))


def test_tamper_raises(tmp_path):
    key = secrets.token_bytes(32)
    src = tmp_path / "plain.bin"
    dst = tmp_path / "enc.fupl"
    src.write_bytes(b"secret data")
    encrypt_file(key, src, dst)
    raw = bytearray(dst.read_bytes())
    raw[-1] ^= 0xFF  # flip last byte of GCM tag
    dst.write_bytes(bytes(raw))
    with pytest.raises(Exception):
        list(decrypt_stream(key, dst))


def test_empty_file_roundtrip(tmp_path):
    key = secrets.token_bytes(32)
    src = tmp_path / "empty.bin"
    dst = tmp_path / "empty.fupl"
    src.write_bytes(b"")
    encrypt_file(key, src, dst)
    recovered = b"".join(decrypt_stream(key, dst))
    assert recovered == b""
