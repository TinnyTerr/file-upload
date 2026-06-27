// Single source of truth for the granular permission schema. Keys match the
// backend `UpdatePermissionsBody` fields (app/routes/users.py). Add a permission
// in one place and it appears in the admin editor + badge list automatically.

export interface PermissionDef {
  key: string;
  label: string;
}

/** Compact badges shown on the admin user table. */
export const PERMISSION_BADGES: PermissionDef[] = [
  { key: "can_upload", label: "upload" },
  { key: "can_upload_client_encrypted", label: "e2e" },
  { key: "can_delete", label: "delete" },
  { key: "can_regenerate_links", label: "links" },
  { key: "can_delete_links", label: "link-del" },
  { key: "can_create_directories", label: "folders" },
  { key: "can_manage_lifecycle", label: "life" },
  { key: "can_use_api_keys", label: "api" },
];

/** Full toggle list shown in the permissions editor modal. */
export const PERMISSION_FIELDS: PermissionDef[] = [
  { key: "can_upload", label: "Upload files" },
  { key: "can_upload_client_encrypted", label: "End-to-end encryption" },
  { key: "can_delete", label: "Delete own files" },
  { key: "can_regenerate_links", label: "Regenerate links" },
  { key: "can_delete_links", label: "Delete links" },
  { key: "can_create_directories", label: "Create folders" },
  { key: "can_manage_lifecycle", label: "Manage lifecycle" },
  { key: "can_use_api_keys", label: "Use API keys" },
  { key: "can_use_p2p", label: "Peer-to-peer" },
  { key: "can_view_admin", label: "View admin" },
  { key: "can_manage_users", label: "Manage users" },
  { key: "can_manage_storage", label: "Manage storage" },
  { key: "can_manage_api_keys", label: "Manage API keys" },
];
