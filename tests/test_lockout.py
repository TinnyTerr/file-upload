from datetime import datetime, timedelta, timezone

from app.db import make_engine, make_session_factory, init_db
from app.security.lockout import LockoutPolicy


def _session():
    engine = make_engine("sqlite:///:memory:")
    init_db(engine)
    return make_session_factory(engine)


def test_locks_after_max_attempts():
    Session = _session()
    policy = LockoutPolicy(max_attempts=3, lockout_seconds=900)
    with Session() as s:
        for _ in range(3):
            assert policy.check_login_allowed(s, "root", "1.2.3.4") is True
            policy.register_failure(s, "root", "user")
            policy.register_failure(s, "1.2.3.4", "ip")
        assert policy.check_login_allowed(s, "root", "1.2.3.4") is False


def test_reset_clears_lock():
    Session = _session()
    policy = LockoutPolicy(max_attempts=2, lockout_seconds=900)
    with Session() as s:
        policy.register_failure(s, "root", "user")
        policy.register_failure(s, "root", "user")
        assert policy.is_locked(s, "root", "user") is True
        policy.reset(s, "root", "user")
        assert policy.is_locked(s, "root", "user") is False


def test_either_identifier_locks_login():
    Session = _session()
    policy = LockoutPolicy(max_attempts=1, lockout_seconds=900)
    with Session() as s:
        policy.register_failure(s, "9.9.9.9", "ip")
        # username clean but IP is locked -> login blocked
        assert policy.check_login_allowed(s, "someone", "9.9.9.9") is False
