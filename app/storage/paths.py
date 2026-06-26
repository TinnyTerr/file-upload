from __future__ import annotations

import os
import secrets
from pathlib import Path


def storage_root() -> Path:
    return Path(os.environ.get("FILEUPLOAD_STORAGE", "./data/storage"))


def new_internal_path() -> Path:
    rand = secrets.token_hex(32)
    return storage_root() / rand[:2] / rand[2:4] / rand[4:]


def safe_join(root: Path, rel: str) -> Path:
    resolved_root = root.resolve()
    target = (root / rel).resolve()
    try:
        target.relative_to(resolved_root)
    except ValueError:
        raise ValueError(f"path traversal: {rel!r}")
    return target
