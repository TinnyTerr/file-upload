from app.db import Base, make_engine, make_session_factory, init_db
from app.models.user import User
from app.models.permission import Permission


def _session():
    engine = make_engine("sqlite:///:memory:")
    init_db(engine)
    return make_session_factory(engine)()


def test_permission_defaults():
    s = _session()
    u = User(username="u", password_hash="x", role="user")
    s.add(u)
    s.flush()
    p = Permission(user_id=u.id)
    s.add(p)
    s.commit()

    got = s.query(Permission).filter_by(user_id=u.id).one()
    assert got.can_upload is True
    assert got.can_upload_client_encrypted is False
    assert got.can_use_api_keys is False
    assert got.can_use_p2p is False
    assert got.quota_bytes == 100 * 1024 ** 3
    assert got.max_file_bytes == 10 * 1024 ** 3
    assert got.archive_after_idle_days == 5
