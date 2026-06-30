from __future__ import annotations

import base64
import os
import secrets
import socket
import uuid
from pathlib import Path

from pydantic_settings import BaseSettings

DEFAULT_CONFIG_PATH = os.environ.get("FILEUPLOAD_CONFIG", "./data/app.env")


class Settings(BaseSettings):
    app_env: str = "dev"
    database_url: str = "sqlite:///./data/app.db"
    secret_key: str = ""
    master_key_b64: str = ""
    config_path: str = DEFAULT_CONFIG_PATH
    trust_proxy: bool = False
    # Comma-separated hostnames that may appear in X-Forwarded-Host when building
    # the HTTPS redirect. Empty = never trust X-Forwarded-Host (use the bound Host).
    allowed_hosts: str = ""
    # Sensitive bearer token for the cluster/monitoring event firehose. Grants
    # read access to ALL events regardless of user or password, so it lives only
    # in this server-side config file and is never tied to a user login.
    cluster_token: str = ""
    # ── cluster node identity ──────────────────────────────────────────────────
    # Stable identifier for THIS server within the cluster. Auto-generated and
    # persisted on first run; used to tag every event/row with its origin node.
    node_id: str = ""
    # Human-readable label for this node (defaults to the hostname).
    node_name: str = ""
    # "master" (initial source of truth every node connects to) or "node".
    node_role: str = "master"
    # This node's externally-reachable base URL, advertised to peers so they can
    # reach back (tail our firehose, fetch blobs). Required to join a cluster.
    node_url: str = ""
    # For non-master nodes: the master's base URL + cluster token used to
    # bootstrap/join the mesh.
    master_url: str = ""
    master_token: str = ""
    # Whether this server retains archived (cold-compressed) blobs. Disable on
    # disk-limited nodes — archived files then live only on archival nodes and are
    # fetched on demand. This is the one intentional per-server difference.
    archive_enabled: bool = True
    # "full" — store every blob locally; "cache" — keep only an LRU set of hot
    # blobs (for disk-limited nodes) and fetch the rest on demand from peers.
    replication_mode: str = "full"
    # LRU budget in bytes for replication_mode="cache" (0 = derive from free disk).
    cache_max_bytes: int = 0


def _parse_bool(value: str | None, *, default: bool = False) -> bool:
    if value is None:
        return default
    normalized = value.strip().lower()
    if normalized in {"1", "true", "yes", "on"}:
        return True
    if normalized in {"0", "false", "no", "off"}:
        return False
    raise ValueError(f"Invalid boolean value: {value!r}")


def _generate_file(path: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    secret_key = secrets.token_urlsafe(32)
    master_key_b64 = base64.b64encode(secrets.token_bytes(32)).decode()
    cluster_token = secrets.token_urlsafe(32)
    node_id = uuid.uuid4().hex
    node_name = socket.gethostname() or node_id[:8]
    # Defaults to prod (Secure cookies, etc.) for real deployments. Tests set
    # FILEUPLOAD_DEFAULT_APP_ENV=dev so the HTTP test client can round-trip the
    # session cookie that prod's Secure flag would otherwise withhold.
    app_env = os.environ.get("FILEUPLOAD_DEFAULT_APP_ENV", "prod")
    body = (
        f"APP_ENV={app_env}\n"
        f"SECRET_KEY={secret_key}\n"
        f"MASTER_KEY_B64={master_key_b64}\n"
        f"CLUSTER_TOKEN={cluster_token}\n"
        f"NODE_ID={node_id}\n"
        f"NODE_NAME={node_name}\n"
        f"NODE_ROLE=master\n"
        f"ARCHIVE_ENABLED=true\n"
        f"REPLICATION_MODE=full\n"
        f"TRUST_PROXY=false\n"
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


def set_env_value(path: Path, key: str, value: str) -> None:
    """Upsert a single KEY=value line in an env file, preserving the rest.

    Used to persist a freshly generated or rotated CLUSTER_TOKEN without
    rewriting (and reordering/commenting away) the whole file.
    """
    lines = path.read_text(encoding="utf-8").splitlines() if path.exists() else []
    out: list[str] = []
    replaced = False
    for line in lines:
        stripped = line.strip()
        if stripped and not stripped.startswith("#") and "=" in stripped:
            existing_key = stripped.partition("=")[0].strip()
            if existing_key == key:
                out.append(f"{key}={value}")
                replaced = True
                continue
        out.append(line)
    if not replaced:
        out.append(f"{key}={value}")
    path.write_text("\n".join(out) + "\n", encoding="utf-8")
    if os.name == "posix":
        os.chmod(path, 0o600)


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
    # Backfill the cluster token for configs created before this feature existed,
    # persisting it so cluster nodes see a stable token across restarts.
    cluster_token = raw.get("CLUSTER_TOKEN", "").strip()
    if not cluster_token:
        cluster_token = secrets.token_urlsafe(32)
        try:
            set_env_value(path, "CLUSTER_TOKEN", cluster_token)
        except OSError:
            pass
    # Backfill a stable node identity for configs predating clustering, persisting
    # it so this node's id is consistent across restarts and to its peers.
    node_id = raw.get("NODE_ID", "").strip()
    if not node_id:
        node_id = uuid.uuid4().hex
        try:
            set_env_value(path, "NODE_ID", node_id)
        except OSError:
            pass
    node_name = raw.get("NODE_NAME", "").strip() or (socket.gethostname() or node_id[:8])
    try:
        cache_max_bytes = int(raw.get("CACHE_MAX_BYTES", "0") or "0")
    except ValueError:
        cache_max_bytes = 0
    return Settings(
        app_env=raw.get("APP_ENV", "dev"),
        database_url=raw.get("DATABASE_URL", "sqlite:///./data/app.db"),
        secret_key=secret_key,
        master_key_b64=master_key_b64,
        config_path=str(path),
        trust_proxy=_parse_bool(raw.get("TRUST_PROXY"), default=False),
        allowed_hosts=raw.get("ALLOWED_HOSTS", ""),
        cluster_token=cluster_token,
        node_id=node_id,
        node_name=node_name,
        node_role=(raw.get("NODE_ROLE", "master").strip().lower() or "master"),
        node_url=raw.get("NODE_URL", "").strip().rstrip("/"),
        master_url=raw.get("MASTER_URL", "").strip().rstrip("/"),
        master_token=raw.get("MASTER_TOKEN", "").strip(),
        archive_enabled=_parse_bool(raw.get("ARCHIVE_ENABLED"), default=True),
        replication_mode=(raw.get("REPLICATION_MODE", "full").strip().lower() or "full"),
        cache_max_bytes=cache_max_bytes,
    )


def get_master_key(settings: Settings) -> bytes:
    return base64.b64decode(settings.master_key_b64)
