import base64
import os
import stat
import pytest
from app.config import load_settings, get_master_key


def test_first_run_generates_secrets(tmp_path):
    cfg = tmp_path / "app.env"
    settings = load_settings(str(cfg))

    assert cfg.exists()
    assert len(settings.secret_key) >= 43
    assert len(get_master_key(settings)) == 32
    # 0600 perms (skip the check on Windows where st_mode differs)
    if os.name == "posix":
        mode = stat.S_IMODE(os.stat(cfg).st_mode)
        assert mode == 0o600


def test_second_load_is_stable(tmp_path):
    cfg = tmp_path / "app.env"
    first = load_settings(str(cfg))
    second = load_settings(str(cfg))
    assert first.secret_key == second.secret_key
    assert first.master_key_b64 == second.master_key_b64


def test_corrupt_file_missing_key_raises(tmp_path):
    cfg = tmp_path / "app.env"
    cfg.write_text("APP_ENV=dev\nMASTER_KEY_B64=abc\n", encoding="utf-8")  # no SECRET_KEY
    with pytest.raises(ValueError):
        load_settings(str(cfg))
