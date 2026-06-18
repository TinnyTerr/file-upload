from app.db import Base, make_engine, make_session_factory, init_db
from app.models.user import User


def test_can_persist_and_read_user():
    engine = make_engine("sqlite:///:memory:")
    init_db(engine)
    Session = make_session_factory(engine)
    with Session() as s:
        s.add(User(username="root", password_hash="x", role="master",
                   must_change_credentials=True))
        s.commit()
    with Session() as s:
        u = s.query(User).filter_by(username="root").one()
        assert u.role == "master"
        assert u.must_change_credentials is True
        assert u.created_at is not None
