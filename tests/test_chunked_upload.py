from __future__ import annotations

import pytest

# Big enough to exercise several chunks when sliced small.
CONTENT = b"chunked payload block " * 5000  # ~110 KB


@pytest.fixture(autouse=True)
def _small_chunks(monkeypatch):
    # Shrink the server chunk size so modest test payloads span many chunks
    # (exercises out-of-order, resume, idempotency).
    monkeypatch.setenv("FILEUPLOAD_CHUNK_SIZE", "4096")


def _init(c, csrf, total, **extra):
    r = c.post(
        "/files/upload/init",
        json={"original_filename": "big.bin", "total_size": total,
              "content_type": "application/octet-stream", **extra},
        headers={"X-CSRF-Token": csrf},
    )
    assert r.status_code == 200, r.text
    return r.json()


def _send_chunk(c, csrf, upload_id, index, piece):
    return c.post(
        "/files/upload/chunk",
        params={"upload_id": upload_id, "index": index},
        content=piece,
        headers={"X-CSRF-Token": csrf, "Content-Type": "application/octet-stream"},
    )


def _slices(content, chunk):
    return [content[off:off + chunk] for off in range(0, len(content), chunk)]


def _chunked_upload(c, csrf, content, *, chunk=4096, indices=None, **init_extra):
    info = _init(c, csrf, len(content), **init_extra)
    upload_id = info["upload_id"]
    # Server dictates chunk_size; slice to it so chunk boundaries line up.
    pieces = _slices(content, info["chunk_size"])
    order = indices if indices is not None else range(len(pieces))
    for i in order:
        r = _send_chunk(c, csrf, upload_id, i, pieces[i])
        assert r.status_code == 200, r.text
    fin = c.post("/files/upload/finalize", json={"upload_id": upload_id},
                 headers={"X-CSRF-Token": csrf})
    assert fin.status_code == 200, fin.text
    return fin.json()


def test_chunked_roundtrip_plain(master_session):
    c, csrf, _ = master_session
    data = _chunked_upload(c, csrf, CONTENT)
    r = c.get(f"/file/{data['slug']}/raw")
    assert r.status_code == 200
    assert r.content == CONTENT


def test_chunks_out_of_order_reassemble_correctly(master_session):
    c, csrf, _ = master_session
    info = _init(c, csrf, len(CONTENT))
    pieces = _slices(CONTENT, info["chunk_size"])
    # Upload in reverse order — assembly must still produce the original bytes.
    for i in reversed(range(len(pieces))):
        assert _send_chunk(c, csrf, info["upload_id"], i, pieces[i]).status_code == 200
    fin = c.post("/files/upload/finalize", json={"upload_id": info["upload_id"]},
                 headers={"X-CSRF-Token": csrf})
    assert fin.status_code == 200, fin.text
    r = c.get(f"/file/{fin.json()['slug']}/raw")
    assert r.content == CONTENT


def test_chunked_roundtrip_server_encrypted(master_session):
    c, csrf, _ = master_session
    data = _chunked_upload(c, csrf, CONTENT, encryption_mode="server")
    assert data["encryption_mode"] == "server"
    assert data["access_key"]
    r = c.get(f"/file/{data['slug']}/raw", params={"ek": data["access_key"]})
    assert r.status_code == 200
    assert r.content == CONTENT


def test_resume_skips_already_uploaded_chunks(master_session):
    c, csrf, _ = master_session
    info = _init(c, csrf, len(CONTENT))
    upload_id = info["upload_id"]
    pieces = _slices(CONTENT, info["chunk_size"])
    assert len(pieces) >= 3, "need several chunks to test resume"

    # Upload only some chunks (simulate a connection that dropped partway).
    done = [0, 2]
    for i in done:
        assert _send_chunk(c, csrf, upload_id, i, pieces[i]).status_code == 200

    # Status reports exactly what landed, so the client knows what to resume.
    st = c.get("/files/upload/status", params={"upload_id": upload_id},
               headers={"X-CSRF-Token": csrf})
    assert st.status_code == 200
    assert sorted(st.json()["received"]) == sorted(done)

    # Finalizing now is refused with the list of missing chunks (parts kept).
    early = c.post("/files/upload/finalize", json={"upload_id": upload_id},
                   headers={"X-CSRF-Token": csrf})
    assert early.status_code == 409
    assert set(early.json()["detail"]["missing"]) == set(range(len(pieces))) - set(done)

    # Send the rest and finalize successfully.
    for i in range(len(pieces)):
        if i not in done:
            assert _send_chunk(c, csrf, upload_id, i, pieces[i]).status_code == 200
    fin = c.post("/files/upload/finalize", json={"upload_id": upload_id},
                 headers={"X-CSRF-Token": csrf})
    assert fin.status_code == 200, fin.text
    assert c.get(f"/file/{fin.json()['slug']}/raw").content == CONTENT


def test_reuploading_a_chunk_is_idempotent(master_session):
    c, csrf, _ = master_session
    info = _init(c, csrf, len(CONTENT))
    pieces = _slices(CONTENT, info["chunk_size"])
    for i in range(len(pieces)):
        assert _send_chunk(c, csrf, info["upload_id"], i, pieces[i]).status_code == 200
    # Re-send chunk 0 — should be accepted and not corrupt anything.
    assert _send_chunk(c, csrf, info["upload_id"], 0, pieces[0]).status_code == 200
    fin = c.post("/files/upload/finalize", json={"upload_id": info["upload_id"]},
                 headers={"X-CSRF-Token": csrf})
    assert fin.status_code == 200
    assert c.get(f"/file/{fin.json()['slug']}/raw").content == CONTENT


def test_chunk_wrong_size_rejected(master_session):
    c, csrf, _ = master_session
    info = _init(c, csrf, len(CONTENT))
    # A non-final chunk that isn't exactly chunk_size must be refused.
    short = b"x" * (info["chunk_size"] - 10)
    r = _send_chunk(c, csrf, info["upload_id"], 0, short)
    assert r.status_code == 400  # incomplete chunk


def test_chunk_overflow_rejected(master_session):
    c, csrf, _ = master_session
    info = _init(c, csrf, 10)
    r = _send_chunk(c, csrf, info["upload_id"], 0, b"x" * 50)
    assert r.status_code == 413


def test_invalid_chunk_index_rejected(master_session):
    c, csrf, _ = master_session
    info = _init(c, csrf, len(CONTENT))
    r = _send_chunk(c, csrf, info["upload_id"], 9999, b"x" * info["chunk_size"])
    assert r.status_code == 400


def test_tampered_token_rejected(master_session):
    c, csrf, _ = master_session
    r = _send_chunk(c, csrf, "not-a-real-token", 0, b"data")
    assert r.status_code == 400


def test_chunked_upload_requires_csrf(master_session):
    c, csrf, _ = master_session
    r = c.post("/files/upload/init",
               json={"original_filename": "x.bin", "total_size": 5})
    assert r.status_code in (401, 403)


def test_abort_discards_partial(master_session):
    c, csrf, _ = master_session
    info = _init(c, csrf, len(CONTENT))
    pieces = _slices(CONTENT, info["chunk_size"])
    _send_chunk(c, csrf, info["upload_id"], 0, pieces[0])
    ab = c.request("DELETE", "/files/upload", params={"upload_id": info["upload_id"]},
                   headers={"X-CSRF-Token": csrf})
    assert ab.status_code == 200
    # Session is gone, so status and finalize now 410.
    assert c.get("/files/upload/status", params={"upload_id": info["upload_id"]},
                 headers={"X-CSRF-Token": csrf}).status_code == 410
    fin = c.post("/files/upload/finalize", json={"upload_id": info["upload_id"]},
                 headers={"X-CSRF-Token": csrf})
    assert fin.status_code == 410
