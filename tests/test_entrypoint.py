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


def test_default_is_single_worker(monkeypatch):
    # A node is one process: the cluster runtime (event seq, recent-events buffer
    # peers poll, halt registry, firehose) is per-process, so >1 worker behaves as
    # several half-nodes and collides on cluster_events' unique seq. Scale by nodes.
    monkeypatch.delenv("FILEUPLOAD_WORKERS", raising=False)
    import app.__main__ as entry
    importlib.reload(entry)
    assert entry.WORKERS == 1


def test_workers_is_overridable(monkeypatch):
    monkeypatch.setenv("FILEUPLOAD_WORKERS", "4")
    import app.__main__ as entry
    importlib.reload(entry)
    assert entry.WORKERS == 4
    monkeypatch.delenv("FILEUPLOAD_WORKERS", raising=False)
    importlib.reload(entry)
