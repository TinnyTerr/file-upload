from __future__ import annotations

import secrets
from pathlib import Path

import pytest

from app.storage.compress import compress_file, decompress_stream, should_compress


def test_should_compress_text():
    assert should_compress("text/plain") is True
    assert should_compress("application/json") is True
    assert should_compress("application/octet-stream") is True


def test_should_compress_skips_already_compressed():
    assert should_compress("image/jpeg") is False
    assert should_compress("image/png") is False
    assert should_compress("video/mp4") is False
    assert should_compress("application/zip") is False
    assert should_compress("application/gzip") is False
    assert should_compress("font/woff2") is False


def test_compress_and_decompress_roundtrip(tmp_path):
    src = tmp_path / "data.txt"
    dst = tmp_path / "data.zst"
    plaintext = b"hello " * 10000
    src.write_bytes(plaintext)
    compressed_size = compress_file(src, dst)
    assert compressed_size < len(plaintext)
    recovered = b"".join(decompress_stream(dst, len(plaintext)))
    assert recovered == plaintext


def test_compress_reduces_size(tmp_path):
    src = tmp_path / "repetitive.bin"
    dst = tmp_path / "repetitive.zst"
    data = b"AAAA" * 100000
    src.write_bytes(data)
    compressed = compress_file(src, dst)
    assert compressed < len(data) // 10


def test_decompress_bomb_guard(tmp_path):
    src = tmp_path / "data.txt"
    dst = tmp_path / "data.zst"
    data = b"A" * 1000
    src.write_bytes(data)
    compress_file(src, dst)
    # Lie about original_size to trigger bomb guard at tiny threshold
    with pytest.raises(ValueError, match="decompression bomb"):
        list(decompress_stream(dst, original_size=1))  # ratio > 50
