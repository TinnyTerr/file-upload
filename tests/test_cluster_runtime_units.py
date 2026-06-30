from __future__ import annotations

import time

from app.cluster.halt import (
    GLOBAL,
    HaltRegistry,
    apply_halt_event,
    halt_registry,
    user_scope,
)
from app.observability.events import EventBus


# ── seq seeding (restart-safe monotonic publish sequence) ───────────────────────

def test_seed_seq_only_advances():
    bus = EventBus()
    bus.seed_seq(50)
    assert bus.publish("x", "a")["id"] == 51
    # A lower (stale) seed never rewinds the sequence …
    bus.seed_seq(10)
    assert bus.publish("y", "a")["id"] == 52
    # … but a higher one (e.g. a larger persisted max) jumps forward.
    bus.seed_seq(1000)
    assert bus.publish("z", "a")["id"] == 1001


# ── peer halt control events applied to the local registry ──────────────────────

def test_apply_peer_halt_then_resume():
    reg = halt_registry
    reg.reset()
    try:
        until = time.time() + 60
        apply_halt_event({"action": "upload.halt", "scope": user_scope(7), "until": until})
        # The halt from a peer now blocks that user locally …
        assert reg.active_until(7) is not None
        # … and an unrelated user is unaffected.
        assert reg.active_until(8) is None
        # A resume control event clears it.
        apply_halt_event({"action": "upload.resume", "scope": user_scope(7)})
        assert reg.active_until(7) is None
    finally:
        reg.reset()


def test_apply_peer_halt_without_until_falls_back_to_ttl():
    reg = halt_registry
    reg.reset()
    try:
        apply_halt_event({"action": "upload.halt", "scope": GLOBAL})  # no 'until'
        # Missing/invalid expiry must still raise a (default-TTL) halt, not no-op.
        assert reg.active_until(None) is not None
    finally:
        reg.reset()


def test_global_halt_affects_every_user():
    reg = HaltRegistry()
    reg.set_ttl(GLOBAL, ttl_seconds=60)
    assert reg.active_until(1) is not None
    assert reg.active_until(999) is not None


def test_halt_set_never_shortens_existing_expiry():
    reg = HaltRegistry()
    far = time.time() + 300
    reg.set(GLOBAL, far)
    reg.set(GLOBAL, time.time() + 1)  # a nearer expiry must not win
    assert reg.snapshot()[GLOBAL] == far


def test_expired_halt_is_pruned():
    reg = HaltRegistry()
    reg.set(GLOBAL, time.time() - 1)  # already in the past
    assert reg.active_until(1) is None
    assert GLOBAL not in reg.snapshot()
