import base64

from fastapi.testclient import TestClient

from app.main import create_app


def _write_config(path, *, app_env="prod", trust_proxy="true"):
    path.write_text(
        f"APP_ENV={app_env}\n"
        "SECRET_KEY=secret-key-for-tests\n"
        f"MASTER_KEY_B64={base64.b64encode(b'k' * 32).decode()}\n"
        f"TRUST_PROXY={trust_proxy}\n",
        encoding="utf-8",
    )


def test_prod_trusted_proxy_redirects_external_http_to_https(tmp_path):
    cfg = tmp_path / "app.env"
    _write_config(cfg, app_env="prod", trust_proxy="true")
    app = create_app(config_path=str(cfg), database_url="sqlite:///:memory:")

    with TestClient(app, base_url="http://files.example.test", follow_redirects=False) as client:
        resp = client.post(
            "/auth/login",
            headers={"X-Forwarded-Proto": "http"},
            json={"username": "admin", "password": "irrelevant"},
        )

    assert resp.status_code == 308
    assert resp.headers["location"] == "https://files.example.test/auth/login"


def test_prod_trusted_proxy_allows_external_https(tmp_path):
    cfg = tmp_path / "app.env"
    _write_config(cfg, app_env="prod", trust_proxy="true")
    app = create_app(config_path=str(cfg), database_url="sqlite:///:memory:")

    with TestClient(app, base_url="http://files.example.test", follow_redirects=False) as client:
        resp = client.get("/login", headers={"X-Forwarded-Proto": "https"})

    assert resp.status_code == 200
