import os
import tempfile
from pathlib import Path

import pytest

from app.storage.paths import storage_root, new_internal_path, safe_join


def test_storage_root_returns_default():
    root = storage_root()
    assert "data" in str(root) or root.exists()


def test_new_internal_path_creates_dirs():
    with tempfile.TemporaryDirectory() as td:
        os.environ["STORAGE_ROOT"] = td
        try:
            p = new_internal_path()
            assert p.exists()
            assert str(p).startswith(str(Path(td)))
            assert len(p.name) == 16  # token_hex(8)
        finally:
            os.environ.pop("STORAGE_ROOT", None)


def test_safe_join_rejects_dotdot():
    with pytest.raises(ValueError, match="path traversal"):
        safe_join(storage_root(), "../etc/passwd")


def test_safe_join_allows_normal():
    p = safe_join(storage_root(), "ab/cd/file.bin")
    assert p.as_posix().endswith("ab/cd/file.bin")