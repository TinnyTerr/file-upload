import os

from app.db import make_engine, make_session_factory, init_db
from app.models.user import User
from app.models.credential import Credential
from app.security.secretbox import seal, open_box


def _session():
    engine = make_engine("sqlite:///:memory:")
    init_db(engine)
    return make_session_factory(engine)()


def test_sealed_totp_secret_round_trips():
    s = _session()
    u = User(username="o", password_hash="x", role="user")
    s.add(u)
    s.flush()

    master_key = os.urandom(32)
    totp_secret = b"JBSWY3DPEHPK3PXP"
    cred = Credential(user_id=u.id, kind="totp", secret_blob=seal(master_key, totp_secret))
    s.add(cred)
    s.commit()

    got = s.query(Credential).one()
    assert got.kind == "totp"
    assert got.secret_blob != totp_secret  # stored sealed, not plaintext
    assert open_box(master_key, got.secret_blob) == totp_secret
    assert got.sign_count == 0
