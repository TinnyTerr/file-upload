from __future__ import annotations

import base64
import os
import secrets
from pathlib import Path

from pydantic_settings import BaseSettings

DEFAULT_CONFIG_PATH = os.environ.get("FILEUPLOAD_CONFIG", "./data/app.env")


class Settings(BaseSettings):
    app_env: str = "dev"
    database_url: str = "sqlite:///./data/app.db"
    secret_key: str = ""
    master_key_b64: str = ""
    config_path: str = DEFAULT_CONFIG_PATH


def _generate_file(path: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    secret_key = secrets.token_urlsafe(32)
    master_key_b64 = base64.b64encode(secrets.token_bytes(32)).decode()
    body = (
        f"APP_ENV=dev\n"
        f"SECRET_KEY={secret_key}\n"
        f"MASTER_KEY_B64={master_key_b64}\n"
    )
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, "w", encoding="utf-8") as f:
        f.write(body)
    if os.name == "posix":
        os.chmod(path, 0o600)  # definitive, in case a restrictive umask altered the create mode


def _parse_env_file(path: Path) -> dict[str, str]:
    values: dict[str, str] = {}
    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, val = line.partition("=")
        values[key.strip()] = val.strip()
    return values


def load_settings(config_path: str | None = None) -> Settings:
    path = Path(config_path or DEFAULT_CONFIG_PATH)
    if not path.exists():
        _generate_file(path)
    raw = _parse_env_file(path)
    try:
        secret_key = raw["SECRET_KEY"]
        master_key_b64 = raw["MASTER_KEY_B64"]
    except KeyError as exc:
        raise ValueError(
            f"Config file {path} is missing required key {exc}. "
            "Delete the file to regenerate it."
        ) from exc
    return Settings(
        app_env=raw.get("APP_ENV", "dev"),
        database_url=raw.get("DATABASE_URL", "sqlite:///./data/app.db"),
        secret_key=secret_key,
        master_key_b64=master_key_b64,
        config_path=str(path),
    )


def get_master_key(settings: Settings) -> bytes:
    return base64.b64decode(settings.master_key_b64)
