from __future__ import annotations

from sqlalchemy.orm import Session

from app.models.permission import Permission

_BOOL_FLAGS = (
    "can_upload",
    "can_upload_client_encrypted",
    "can_delete",
    "can_regenerate_links",
    "can_delete_links",
    "can_create_directories",
    "can_manage_lifecycle",
    "can_use_api_keys",
    "can_view_admin",
    "can_manage_users",
    "can_manage_storage",
    "can_manage_api_keys",
    "can_manage_cluster",
)


def get_permissions(session: Session, user_id: int) -> Permission | None:
    return session.query(Permission).filter_by(user_id=user_id).one_or_none()


def ensure_permissions(session: Session, user_id: int, *, master: bool = False) -> Permission:
    existing = get_permissions(session, user_id)
    if existing is not None:
        return existing
    perm = Permission(user_id=user_id)
    if master:
        for flag in _BOOL_FLAGS:
            setattr(perm, flag, True)
    session.add(perm)
    session.flush()
    return perm


def has_permission(perm: Permission, name: str) -> bool:
    if name not in _BOOL_FLAGS:
        raise AttributeError(f"unknown permission flag: {name}")
    return bool(getattr(perm, name))
