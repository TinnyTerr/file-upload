from app.security.passwords import hash_password, verify_password


def test_hash_roundtrip():
    h = hash_password("correct horse")
    assert h != "correct horse"
    assert h.startswith("$argon2id$")
    assert verify_password("correct horse", h) is True
    assert verify_password("wrong", h) is False
