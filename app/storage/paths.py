from __future__ import annotations

import os
import secrets
from pathlib import Path


def storage_root() -> Path:
    base = Path(os.environ.get("STORAGE_ROOT", "./data"))
    return base / "files"


def new_internal_path() -> Path:
    """Create a random hex directory tree and return the leaf path."""
    root = storage_root()
    parts = [secrets.token_hex(8) for _ in range(3)]
    leaf = root.joinpath(*parts)
    leaf.mkdir(parents=True, exist_ok=True)
    return leaf


def safe_join(root: Path, rel: str) -> Path:
    # Normalize separators so this works on both POSIX and Windows
    if ".." in rel.replace("\\", "/").split("/"):
        raise ValueError("path traversal detected")
    return root / rel