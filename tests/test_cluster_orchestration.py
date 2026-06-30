from __future__ import annotations

from app.cluster.digest import sync_check_job
from app.cluster.membership import heartbeat_job, join_cluster
from app.cluster.replication import rebase_from_master, replicate_file
from app.cluster.blobs import fetch_blob_from_peers
from app.models.cluster_node import ClusterNode
from app.models.content_blob import ContentBlob
from app.models.file import FileObject


# ── metadata replication (announce-id push) ─────────────────────────────────────

def test_replicate_file_pushes_metadata_to_peer(cluster_pair):
    a, b = cluster_pair.a, cluster_pair.b
    up = a.upload(name="pushed.bin", body=b"push-me")
    a.link(b, is_master=False)

    result = replicate_file(a.settings, a.session_factory, up["file_id"])
    assert result == "ok"

    # The file is now usable on B: its metadata landed and the public info
    # endpoint resolves the slug.
    with b.session_factory() as s:
        assert s.query(FileObject).filter_by(original_filename="pushed.bin").count() == 1
    assert b.client.get(f"/file/{up['slug']}/info").status_code == 200


def test_replicate_file_without_peers_is_noop(cluster_pair):
    a = cluster_pair.a
    up = a.upload()
    # No peers linked → nothing to announce/push.
    assert replicate_file(a.settings, a.session_factory, up["file_id"]) == "noop"


# ── rebase from master (the conflict sledgehammer / join bootstrap) ─────────────

def test_rebase_pulls_master_snapshot(cluster_pair):
    a, b = cluster_pair.a, cluster_pair.b
    # B is the master and holds canonical state.
    b.upload(name="canonical.bin", body=b"from-master")
    a.link(b, is_master=True)

    assert rebase_from_master(a.settings, a.session_factory) is True
    with a.session_factory() as s:
        assert s.query(FileObject).filter_by(original_filename="canonical.bin").count() == 1


def test_rebase_without_a_master_returns_false(cluster_pair):
    a, b = cluster_pair.a, cluster_pair.b
    a.link(b, is_master=False)  # peer present, but none is the master
    assert rebase_from_master(a.settings, a.session_factory) is False


# ── membership: join forms a symmetric mesh and bootstraps state ────────────────

def test_join_cluster_is_symmetric_and_rebases(cluster_pair, monkeypatch):
    a, b = cluster_pair.a, cluster_pair.b  # a = master, b = joiner
    a.upload(name="seed.bin", body=b"seed")

    monkeypatch.setattr(b.settings, "node_role", "node")
    monkeypatch.setattr(b.settings, "master_url", a.url)
    monkeypatch.setattr(b.settings, "master_token", a.token)
    monkeypatch.setattr(b.settings, "node_url", b.url)

    join_cluster(b.settings, b.session_factory)

    # B linked A as its master …
    with b.session_factory() as s:
        master = s.query(ClusterNode).filter_by(node_id=a.node_id).one_or_none()
        assert master is not None and master.is_master is True
    # … A linked B back (symmetric mesh) …
    with a.session_factory() as s:
        assert s.query(ClusterNode).filter_by(node_id=b.node_id).count() == 1
    # … and B rebased the master's canonical state on join.
    with b.session_factory() as s:
        assert s.query(FileObject).filter_by(original_filename="seed.bin").count() == 1


# ── heartbeat: refreshes peer stats; marks unreachable peers stale ──────────────

def test_heartbeat_refreshes_then_marks_stale(cluster_pair):
    a, b = cluster_pair.a, cluster_pair.b
    b.upload(name="usage.bin", body=b"some-bytes-on-b")
    a.link(b, is_master=False)

    reached = heartbeat_job(a.settings, a.session_factory)
    assert reached == 1
    with a.session_factory() as s:
        node = s.query(ClusterNode).filter_by(node_id=b.node_id).one()
        assert node.active is True
        assert node.last_heartbeat_at is not None
        assert node.used_bytes > 0  # B's real usage flowed back

    # Simulate B going offline → heartbeat marks it stale rather than deleting it.
    cluster_pair.routes.pop(b.url)
    reached2 = heartbeat_job(a.settings, a.session_factory)
    assert reached2 == 0
    with a.session_factory() as s:
        node = s.query(ClusterNode).filter_by(node_id=b.node_id).one()
        assert node.active is False


# ── sync digest: agree when in sync, alert on divergence ────────────────────────

def test_sync_check_agrees_then_detects_divergence(cluster_pair):
    a, b = cluster_pair.a, cluster_pair.b
    a.link(b, is_master=False)
    b.link(a, is_master=True)

    # Same global quota + symmetric membership → digests match.
    # (digest helpers take session_factory first, unlike membership/replication.)
    assert sync_check_job(a.session_factory, a.settings) == 0

    # Diverge B's shared global quota; A must now report a mismatch.
    from app.storage.accounting import ensure_storage_settings
    with b.session_factory() as s:
        st = ensure_storage_settings(s)
        st.global_storage_quota_bytes = int(st.global_storage_quota_bytes) + 999_999
        s.commit()

    assert sync_check_job(a.session_factory, a.settings) == 1


# ── blob failover: pull content bytes from a peer that still holds them ──────────

def test_fetch_blob_from_peers_streams_from_holder(cluster_pair, tmp_path):
    a, b = cluster_pair.a, cluster_pair.b
    b.upload(name="blob.bin", body=b"blob-payload-bytes")
    a.link(b, is_master=False)

    with b.session_factory() as s:
        blob = s.query(ContentBlob).first()
        sha, transform = blob.stored_sha256, blob.transform_key

    expected = b.client.get(
        f"/cluster/blobs/{sha}?transform={transform}",
        headers={"Authorization": f"Bearer {b.token}"},
    ).content

    dest = tmp_path / "recovered.bin"
    ok = fetch_blob_from_peers(
        a.session_factory, stored_sha256=sha, transform_key=transform, dest=dest
    )
    assert ok is True
    assert dest.read_bytes() == expected and len(expected) > 0


def test_fetch_blob_returns_false_when_no_peer_has_it(cluster_pair, tmp_path):
    a, b = cluster_pair.a, cluster_pair.b
    a.link(b, is_master=False)
    dest = tmp_path / "missing.bin"
    ok = fetch_blob_from_peers(
        a.session_factory, stored_sha256="0" * 64, transform_key="plain", dest=dest
    )
    assert ok is False
    assert not dest.exists()
