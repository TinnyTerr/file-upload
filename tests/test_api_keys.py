from datetime import datetime, timezone

from app.db import make_engine, make_session_factory, init_db
from app.models.user import User
from app.models.api_key import ApiKey
from app.security.api_keys import generate_key, hash_key, bind_or_reject


def _session():
    engine = make_engine("sqlite:///:memory:")
    init_db(engine)
    return make_session_factory(engine)()


def test_generate_is_random_and_long():
    a, b = generate_key(), generate_key()
    assert a != b
    assert len(a) >= 40


def test_hash_is_stable_and_hex():
    h = hash_key("abc")
    assert h == hash_key("abc")
    assert len(h) == 64
    int(h, 16)  # valid hex


def test_first_use_binds_ip():
    now = datetime.now(timezone.utc)
    k = ApiKey(owner_id=1, key_hash=hash_key("x"))
    assert bind_or_reject(k, "10.0.0.5", now) is True
    assert k.bound_ip == "10.0.0.5"
    assert k.last_used_at == now


def test_same_ip_allowed_updates_last_used():
    now = datetime.now(timezone.utc)
    k = ApiKey(owner_id=1, key_hash=hash_key("x"), bound_ip="10.0.0.5")
    assert bind_or_reject(k, "10.0.0.5", now) is True
    assert k.last_used_at == now


def test_different_ip_rejected_no_mutation():
    k = ApiKey(owner_id=1, key_hash=hash_key("x"), bound_ip="10.0.0.5")
    assert bind_or_reject(k, "10.0.0.9", datetime.now(timezone.utc)) is False
    assert k.bound_ip == "10.0.0.5"  # unchanged
