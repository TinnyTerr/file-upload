from datetime import datetime, timedelta, timezone

from app.db import make_engine, make_session_factory, init_db
from app.models.user import User
from app.models.file import FileObject
from app.models.link import Link
from app.links.slugs import new_slug
from app.links.consume import resolve_active_link, consume_use


def _setup():
    engine = make_engine("sqlite:///:memory:")
    init_db(engine)
    return make_session_factory(engine)()


def _file(s):
    u = User(username="o", password_hash="x", role="user")
    s.add(u)
    s.flush()
    f = FileObject(owner_id=u.id, storage_path="p", original_filename="x")
    s.add(f)
    s.flush()
    return f


def test_consume_respects_max_uses():
    s = _setup()
    f = _file(s)
    slug = new_slug()
    s.add(Link(file_id=f.id, slug=slug, max_uses=2))
    s.commit()

    assert consume_use(s, slug) is True
    s.commit()
    assert consume_use(s, slug) is True
    s.commit()
    assert consume_use(s, slug) is False  # cap reached
    s.commit()
    assert s.query(Link).filter_by(slug=slug).one().use_count == 2


def test_unlimited_uses_when_max_is_null():
    s = _setup()
    f = _file(s)
    slug = new_slug()
    s.add(Link(file_id=f.id, slug=slug, max_uses=None))
    s.commit()
    for _ in range(5):
        assert consume_use(s, slug) is True
        s.commit()


def test_resolve_skips_expired_and_inactive():
    s = _setup()
    f = _file(s)
    past = datetime.now(timezone.utc) - timedelta(hours=1)
    expired = new_slug()
    inactive = new_slug()
    s.add(Link(file_id=f.id, slug=expired, expires_at=past))
    s.add(Link(file_id=f.id, slug=inactive, active=False))
    s.commit()
    assert resolve_active_link(s, expired) is None
    assert resolve_active_link(s, inactive) is None
    assert consume_use(s, expired) is False
    assert consume_use(s, inactive) is False


def test_resolve_returns_live_link():
    s = _setup()
    f = _file(s)
    slug = new_slug()
    s.add(Link(file_id=f.id, slug=slug))
    s.commit()
    assert resolve_active_link(s, slug).slug == slug
