from __future__ import annotations


def _upload(c, csrf, name="audit-search.txt"):
    r = c.post(
        "/files/upload",
        files={"file": (name, b"audit", "text/plain")},
        data={"original_filename": name},
        headers={"X-CSRF-Token": csrf},
    )
    assert r.status_code == 200, r.text
    return r.json()


def test_audit_log_search_filters_server_side(master_session):
    c, csrf, _ = master_session
    uploaded = _upload(c, csrf)

    hit = c.get("/audit/", params={"q": f"file:{uploaded['file_id']}", "limit": 50})
    assert hit.status_code == 200, hit.text
    body = hit.json()
    assert body["filtered_count"] >= 1
    assert body["total_count"] >= body["filtered_count"]
    assert all(f"file:{uploaded['file_id']}" in (entry["target"] or "") for entry in body["entries"])

    miss = c.get("/audit/", params={"q": "definitely-not-in-audit-log", "limit": 50})
    assert miss.status_code == 200, miss.text
    assert miss.json()["filtered_count"] == 0
    assert miss.json()["entries"] == []


def test_audit_log_action_filter_and_action_catalog(master_session):
    c, csrf, _ = master_session
    _upload(c, csrf)

    body = c.get("/audit/", params={"action": "file.uploaded", "limit": 50}).json()

    assert body["filtered_count"] >= 1
    assert all(entry["action"] == "file.uploaded" for entry in body["entries"])
    assert "file.uploaded" in body["actions"]
