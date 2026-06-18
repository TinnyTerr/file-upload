from app.db import make_engine, make_session_factory, init_db
from app.audit.log import install_append_only_triggers
from app.bootstrap import ensure_master
from app.models.user import User
from app.security.passwords import verify_password


def _session():
    engine = make_engine("sqlite:///:memory:")
    init_db(engine)
    install_append_only_triggers(engine)
    return make_session_factory(engine)


def test_creates_master_once_with_printed_password():
    Session = _session()
    printed = []
    with Session() as s:
        pw = ensure_master(s, print_fn=printed.append)
        assert pw is not None
        u = s.query(User).one()
        assert u.role == "master"
        assert u.must_change_credentials is True
        assert verify_password(pw, u.password_hash)
        assert any(pw in line for line in printed)


def test_second_call_is_noop():
    Session = _session()
    with Session() as s:
        ensure_master(s, print_fn=lambda _: None)
    with Session() as s:
        assert ensure_master(s, print_fn=lambda _: None) is None
        assert s.query(User).count() == 1


def test_master_gets_full_permissions():
    from app.db import make_engine, make_session_factory, init_db
    from app.models.user import User
    from app.models.permission import Permission
    from app.bootstrap import ensure_master

    engine = make_engine("sqlite:///:memory:")
    init_db(engine)
    s = make_session_factory(engine)()
    ensure_master(s, print_fn=lambda *_: None)

    master = s.query(User).filter_by(role="master").one()
    perm = s.query(Permission).filter_by(user_id=master.id).one()
    assert perm.can_upload is True
    assert perm.can_use_api_keys is True
    assert perm.can_upload_client_encrypted is True
