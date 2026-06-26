from app.db import make_engine, make_session_factory, init_db
from app.models.user import User
from app.models.file import FileObject


def _session():
    engine = make_engine("sqlite:///:memory:")
    init_db(engine)
    return make_session_factory(engine)()


def test_file_defaults():
    s = _session()
    u = User(username="o", password_hash="x", role="user")
    s.add(u)
    s.flush()
    f = FileObject(owner_id=u.id, storage_path="ab/cd/rand", original_filename="x.txt")
    s.add(f)
    s.commit()

    got = s.query(FileObject).one()
    assert got.encryption_mode == "none"
    assert got.lifecycle_state == "active"
    assert got.is_permanent is True
    assert got.archived is False
    assert got.auto_unarchive_on_download is True
    assert got.size_bytes == 0
    assert got.last_downloaded_at is None
