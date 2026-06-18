import pytest
from sqlalchemy.exc import IntegrityError, OperationalError

from app.db import make_engine, make_session_factory, init_db
from app.audit.log import install_append_only_triggers, record, verify_chain, _hash_row
from app.models.audit import AuditEntry


def _setup():
    engine = make_engine("sqlite:///:memory:")
    init_db(engine)
    install_append_only_triggers(engine)
    return make_session_factory(engine)


def test_record_builds_chain_and_verifies():
    Session = _setup()
    with Session() as s:
        record(s, actor="root", action="login.success", ip="1.2.3.4")
        record(s, actor="root", action="link.create", target="file:1", ip="1.2.3.4")
        s.commit()
        assert verify_chain(s) is True
        rows = s.query(AuditEntry).order_by(AuditEntry.id).all()
        assert rows[1].prev_hash == rows[0].entry_hash


def test_update_and_delete_are_blocked():
    Session = _setup()
    with Session() as s:
        record(s, actor="root", action="login.success", ip="1.2.3.4")
        s.commit()
    with Session() as s:
        with pytest.raises((IntegrityError, OperationalError)):
            s.execute(AuditEntry.__table__.update().values(action="tampered"))
            s.commit()
    with Session() as s:
        with pytest.raises((IntegrityError, OperationalError)):
            s.execute(AuditEntry.__table__.delete())
            s.commit()


def test_tampered_chain_fails_verification():
    # Use an engine WITHOUT append-only triggers so a row CAN be mutated at the
    # storage layer, then prove verify_chain detects the broken chain.
    from sqlalchemy import update
    from app.db import make_engine, make_session_factory, init_db
    engine = make_engine("sqlite:///:memory:")
    init_db(engine)
    Session = make_session_factory(engine)
    with Session() as s:
        record(s, actor="root", action="a", ip="1.1.1.1")
        record(s, actor="root", action="b", ip="1.1.1.1")
        s.commit()
        assert verify_chain(s) is True
        s.execute(update(AuditEntry).where(AuditEntry.id == 1).values(action="tampered"))
        s.commit()
        s.expire_all()
        assert verify_chain(s) is False


def test_delimiter_injection_does_not_collide():
    from datetime import datetime, timezone
    ts = datetime(2024, 1, 1, tzinfo=timezone.utc)
    h1 = _hash_row("0" * 64, "a|b", "c", None, "ip", ts)
    h2 = _hash_row("0" * 64, "a", "b|c", None, "ip", ts)
    assert h1 != h2
