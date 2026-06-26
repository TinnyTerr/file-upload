import os

import pytest
from cryptography.exceptions import InvalidTag

from app.security.secretbox import seal, open_box


def test_round_trip():
    key = os.urandom(32)
    pt = b"the quick brown fox"
    blob = seal(key, pt)
    assert blob != pt
    assert open_box(key, blob) == pt


def test_unique_iv_per_seal():
    key = os.urandom(32)
    a = seal(key, b"same")
    b = seal(key, b"same")
    assert a != b  # random IV => different ciphertext each time


def test_tamper_is_rejected():
    key = os.urandom(32)
    blob = bytearray(seal(key, b"data"))
    blob[-1] ^= 0x01  # flip a tag bit
    with pytest.raises(InvalidTag):
        open_box(key, bytes(blob))


def test_wrong_key_is_rejected():
    blob = seal(os.urandom(32), b"data")
    with pytest.raises(InvalidTag):
        open_box(os.urandom(32), blob)


def test_aad_mismatch_is_rejected():
    key = os.urandom(32)
    blob = seal(key, b"data", aad=b"file:1")
    with pytest.raises(InvalidTag):
        open_box(key, blob, aad=b"file:2")
