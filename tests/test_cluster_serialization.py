from __future__ import annotations

from datetime import datetime

from app.cluster.replication import (
    _row_kwargs,
    apply_rows,
    identity_hash,
    serialize_row,
)
from app.models.file import FileObject
from app.models.user import User


def _upload(c, csrf, *, name="ser.bin", body=b"serialize-me"):
    r = c.post(
        "/files/upload",
        files={"file": (name, body, "application/octet-stream")},
        data={"original_filename": name, "randomize_filename": "false"},
        headers={"X-CSRF-Token": csrf},
    )
    assert r.status_code == 200, r.text
    return r.json()


def test_datetime_roundtrips_through_serialize(master_session, app_client):
    """Regression: UTCDateTime.python_type raises NotImplementedError, so datetime
    columns must be detected by their type. A broken detector left created_at as a
    bare ISO string and replication 500'd with "'str' has no attribute 'tzinfo'"."""
    c, csrf, _pw = master_session
    state = app_client[1]
    file_id = _upload(c, csrf)["file_id"]

    with state.session_factory() as s:
        f = s.get(FileObject, file_id)
        data = serialize_row(f)["data"]

    # On the wire a datetime is an ISO string …
    assert isinstance(data["created_at"], str)
    # … and it must rehydrate back into a real datetime for the ORM insert.
    kwargs = _row_kwargs(FileObject, data)
    assert isinstance(kwargs["created_at"], datetime)


def test_bytes_roundtrip_through_serialize(master_session, app_client):
    c, _csrf, _pw = master_session
    state = app_client[1]
    secret = b"\x00\x01\x02\xff\xfe binary avatar"

    with state.session_factory() as s:
        admin = s.query(User).filter_by(username="admin").one()
        admin.avatar_data = secret
        s.flush()
        data = serialize_row(admin)["data"]

    # Bytes are base64-enveloped on the wire …
    assert isinstance(data["avatar_data"], dict) and "__b64__" in data["avatar_data"]
    # … and decode back to the exact original bytes.
    kwargs = _row_kwargs(User, data)
    assert kwargs["avatar_data"] == secret


def test_identity_hash_is_stable_across_serialize(master_session, app_client):
    c, csrf, _pw = master_session
    state = app_client[1]
    file_id = _upload(c, csrf)["file_id"]
    with state.session_factory() as s:
        f = s.get(FileObject, file_id)
        d1 = serialize_row(f)["data"]
        d2 = serialize_row(f)["data"]
    assert identity_hash("files", d1) == identity_hash("files", d2)


def test_apply_rows_is_idempotent_and_orders_parents_first(master_session, app_client):
    """apply_rows merges by PK (idempotent) and sorts parents before children, so a
    file row never lands before the user/blob it references."""
    c, csrf, _pw = master_session
    state = app_client[1]
    file_id = _upload(c, csrf)["file_id"]

    from app.cluster.replication import collect_file_rows
    with state.session_factory() as s:
        rows = collect_file_rows(s, file_id)

    # Deliberately shuffle so child rows precede parents; apply_rows must reorder.
    rows = list(reversed(rows))
    with state.session_factory() as s:
        n1 = apply_rows(s, rows)
        s.commit()
        n2 = apply_rows(s, rows)  # re-apply: still a single logical file
        s.commit()
        assert n1 == n2 > 0
        assert s.query(FileObject).filter_by(id=file_id).count() == 1
