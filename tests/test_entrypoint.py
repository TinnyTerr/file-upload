import importlib
import os


def test_default_bind_is_all_interfaces(monkeypatch):
    # Cluster peers must be able to reach this node, so the default bind is
    # 0.0.0.0. (XFF is only trusted behind a proxy via TRUST_PROXY.)
    monkeypatch.delenv("FILEUPLOAD_BIND_HOST", raising=False)
    import app.__main__ as entry
    importlib.reload(entry)
    assert entry.HOST == "0.0.0.0"


def test_bind_host_is_overridable(monkeypatch):
    monkeypatch.setenv("FILEUPLOAD_BIND_HOST", "127.0.0.1")
    import app.__main__ as entry
    importlib.reload(entry)
    assert entry.HOST == "127.0.0.1"
    # Restore module state for any later imports in this process.
    monkeypatch.delenv("FILEUPLOAD_BIND_HOST", raising=False)
    importlib.reload(entry)
