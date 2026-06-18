from app.db import make_engine, make_session_factory, init_db
from app.links.slugs import new_slug
from app.models.user import User
from app.models.file import FileObject
from app.models.link import Link


def _session():
    engine = make_engine("sqlite:///:memory:")
    init_db(engine)
    return make_session_factory(engine)()


def test_slug_is_random_and_urlsafe():
    a, b = new_slug(), new_slug()
    assert a != b
    assert len(a) >= 22  # token_urlsafe(16) ~ 22 chars
    assert "/" not in a and "+" not in a


def test_link_defaults_and_fk():
    s = _session()
    u = User(username="o", password_hash="x", role="user")
    s.add(u)
    s.flush()
    f = FileObject(owner_id=u.id, storage_path="p", original_filename="x")
    s.add(f)
    s.flush()
    link = Link(file_id=f.id, slug=new_slug())
    s.add(link)
    s.commit()

    got = s.query(Link).one()
    assert got.use_count == 0
    assert got.max_uses is None
    assert got.active is True
