from app.__main__ import HOST


def test_binds_loopback_only():
    assert HOST == "127.0.0.1"
