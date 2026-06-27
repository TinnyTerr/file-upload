from __future__ import annotations

import logging


def test_backend_logs_capture_and_filter_runtime_messages(master_session):
    c, _csrf, _ = master_session
    logging.getLogger("app.test.backend").info("backend-log-needle visible in admin")
    logging.getLogger("app.test.backend").warning("backend-log-other warning")

    resp = c.get("/admin/backend/logs", params={"q": "needle", "limit": 50})

    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["total_count"] >= 2
    assert body["filtered_count"] == 1
    assert body["entries"][0]["message"] == "backend-log-needle visible in admin"
    assert body["entries"][0]["level"] == "INFO"
    assert body["entries"][0]["logger"] == "app.test.backend"


def test_backend_logs_can_filter_by_level(master_session):
    c, _csrf, _ = master_session
    logging.getLogger("app.test.backend").info("backend-log-info-level")
    logging.getLogger("app.test.backend").error("backend-log-error-level")

    resp = c.get("/admin/backend/logs", params={"level": "ERROR", "limit": 50})

    assert resp.status_code == 200, resp.text
    messages = [entry["message"] for entry in resp.json()["entries"]]
    assert "backend-log-error-level" in messages
    assert "backend-log-info-level" not in messages


def test_backend_restart_workers_endpoint_restarts_scheduler(master_session):
    c, csrf, _ = master_session

    resp = c.post(
        "/admin/backend/restart-workers",
        headers={"X-CSRF-Token": csrf},
    )

    assert resp.status_code == 200, resp.text
    assert resp.json()["status"] == "restarted"
    log_messages = [
        entry["message"]
        for entry in c.get("/admin/backend/logs", params={"q": "worker", "limit": 50}).json()["entries"]
    ]
    assert any("worker" in message.lower() for message in log_messages)
