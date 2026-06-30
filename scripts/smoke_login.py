#!/usr/bin/env python3
"""End-to-end smoke test for the login / cluster-event-mirror crash.

Reproduces the exact production failure: a fresh multi-worker startup where the
first logins 500'd with
    PendingRollbackError ... UNIQUE constraint failed:
    cluster_events.origin_node_id, cluster_events.origin_seq
because each worker process owns an independent in-memory publish seq but they
all share one node_id and one on-disk DB.

This spins up a *real* server (not the in-process TestClient, which can never
exercise a multi-process race) against a throwaway file DB and asserts:

  Phase 1  workers=4, hammer /auth/login concurrently  -> no 500s
           (provokes cross-worker (node_id, seq) collisions; the SAVEPOINT in
            app.audit.log.record must contain them).
  Phase 2  restart workers=1 against the SAME db, login -> no 500s
           (the seq must resume from MAX(origin_seq), not reset to 0 and collide
            with rows written before the restart).

Run:  .venv/bin/python3 scripts/smoke_login.py
Exits 0 on success, 1 on failure. Picks its own free port (the real entrypoint
hardcodes 7474; we override via FILEUPLOAD_BIND_PORT so the smoke test never
clashes with a running instance).
"""
from __future__ import annotations

import json
import os
import re
import socket
import subprocess
import sys
import tempfile
import threading
import time
import urllib.error
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
PYTHON = sys.executable
USERNAME = "admin"


def _free_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


class Server:
    """A child `python -m app` process whose stdout we tee so we can scrape the
    first-run admin password and wait for readiness."""

    def __init__(self, *, port: int, workers: int, cwd: Path, config: Path):
        env = dict(os.environ)
        env.update(
            FILEUPLOAD_BIND_HOST="127.0.0.1",
            FILEUPLOAD_BIND_PORT=str(port),
            FILEUPLOAD_WORKERS=str(workers),
            FILEUPLOAD_CONFIG=str(config),
            FILEUPLOAD_DEFAULT_APP_ENV="dev",  # HTTP cookies, not Secure
            PYTHONUNBUFFERED="1",
        )
        self.port = port
        self.workers = workers
        self.lines: list[str] = []
        self.password: str | None = None
        self._proc = subprocess.Popen(
            [PYTHON, "-m", "app"],
            cwd=str(cwd), env=env,
            stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True,
        )
        self._reader = threading.Thread(target=self._pump, daemon=True)
        self._reader.start()

    def _pump(self) -> None:
        assert self._proc.stdout is not None
        for line in self._proc.stdout:
            self.lines.append(line)
            m = re.search(r"password:\s*(\S+)", line)
            if m and self.password is None:
                self.password = m.group(1)

    def wait_ready(self, timeout: float = 30.0) -> None:
        deadline = time.time() + timeout
        while time.time() < deadline:
            if self._proc.poll() is not None:
                raise RuntimeError(
                    f"server exited early (code {self._proc.returncode}):\n"
                    + "".join(self.lines)
                )
            try:
                with socket.create_connection(("127.0.0.1", self.port), timeout=0.5):
                    # Port open; give workers a beat to finish startup.
                    time.sleep(1.0)
                    return
            except OSError:
                time.sleep(0.2)
        raise TimeoutError("server did not become ready:\n" + "".join(self.lines))

    def stop(self) -> None:
        self._proc.terminate()
        try:
            self._proc.wait(timeout=10)
        except subprocess.TimeoutExpired:
            self._proc.kill()
            self._proc.wait(timeout=5)


def login(port: int, password: str) -> int:
    """POST /auth/login, return HTTP status (0 on transport error)."""
    body = json.dumps({"username": USERNAME, "password": password}).encode()
    req = urllib.request.Request(
        f"http://127.0.0.1:{port}/auth/login", data=body,
        headers={"Content-Type": "application/json"}, method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            return resp.status
    except urllib.error.HTTPError as e:
        return e.code
    except (urllib.error.URLError, OSError, TimeoutError):
        # Transport error / read timeout — report as a failure (0), not a crash.
        return 0


def hammer(port: int, password: str, *, n: int) -> list[int]:
    with ThreadPoolExecutor(max_workers=min(n, 32)) as pool:
        return list(pool.map(lambda _: login(port, password), range(n)))


def main() -> int:
    tmp = Path(tempfile.mkdtemp(prefix="fileupload-smoke-"))
    config = tmp / "data" / "app.env"
    port = _free_port()
    failures: list[str] = []

    # ── Phase 1: fresh DB, 4 workers, concurrent logins (the original crash) ──
    print(f"[phase 1] starting workers=4 on :{port} (cwd={tmp})")
    s1 = Server(port=port, workers=4, cwd=tmp, config=config)
    try:
        s1.wait_ready()
        if not s1.password:
            raise RuntimeError("could not scrape first-run admin password:\n"
                               + "".join(s1.lines))
        # A modest concurrent burst at fresh startup is enough to make several of
        # the 4 workers each emit their first event (seq=1) and collide; Argon2 is
        # deliberately heavy, so going wider just saturates CPU without adding
        # signal. We assert on 500s, not throughput.
        print("[phase 1] admin password scraped; firing 12 concurrent logins")
        codes = hammer(port, s1.password, n=12)
        bad = [c for c in codes if c >= 500 or c == 0]
        ok = sum(1 for c in codes if c == 200)
        print(f"[phase 1] results: 200x{ok}  others={sorted(set(codes) - {200})}")
        if bad:
            failures.append(f"phase 1 had {len(bad)} failed logins: {bad[:5]}")
        if "UNIQUE constraint failed: cluster_events" in "".join(s1.lines):
            failures.append("phase 1 server log shows the cluster_events UNIQUE crash")
    finally:
        s1.stop()

    # ── Phase 2: restart workers=1 against the SAME db (seq seeding) ──
    password = s1.password
    print(f"[phase 2] restarting workers=1 on :{port} against the same DB")
    s2 = Server(port=port, workers=1, cwd=tmp, config=config)
    try:
        s2.wait_ready()
        # No first-run print this time (user already exists) -> reuse password.
        code = login(port, password) if password else 0
        print(f"[phase 2] post-restart login -> {code}")
        if code >= 500 or code == 0:
            failures.append(f"phase 2 login after restart returned {code}")
        if "UNIQUE constraint failed: cluster_events" in "".join(s2.lines):
            failures.append("phase 2 server log shows the cluster_events UNIQUE crash")
    finally:
        s2.stop()

    print("-" * 60)
    if failures:
        print("SMOKE TEST FAILED:")
        for f in failures:
            print("  -", f)
        return 1
    print("SMOKE TEST PASSED: no 500s, no cluster_events UNIQUE crash.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
