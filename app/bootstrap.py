from __future__ import annotations

import secrets
from typing import Callable

from sqlalchemy.orm import Session

from app.audit.log import record
from app.models.user import User
from app.permissions.policy import ensure_permissions
from app.security.passwords import hash_password

DEFAULT_USERNAME = "admin"


def ensure_master(session: Session, print_fn: Callable[[str], None] = print) -> str | None:
    if session.query(User).count() > 0:
        return None
    password = secrets.token_urlsafe(12)
    master = User(
        username=DEFAULT_USERNAME,
        password_hash=hash_password(password),
        role="master",
        must_change_credentials=True,
    )
    session.add(master)
    session.flush()
    ensure_permissions(session, master.id, master=True)
    record(session, actor="system", action="bootstrap.master_created",
           target=f"user:{master.id}")
    session.commit()
    print_fn("=" * 60)
    print_fn(" FIRST-RUN ADMIN CREATED")
    print_fn(f"   username: {DEFAULT_USERNAME}")
    print_fn(f"   password: {password}")
    print_fn("   You MUST change the username and password on first login.")
    print_fn("=" * 60)
    return password
