/** Permission flags mirrored from the backend (see app/routes/account.py). */
export const PERMISSION_FLAGS = [
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
  "can_use_torrents",
] as const;

export type PermissionFlag = (typeof PERMISSION_FLAGS)[number];

/** Pure permission check for non-hook callers. Masters implicitly have every flag. */
export function hasPermission(
  user: ({ role: string } & Partial<Record<PermissionFlag, boolean>>) | null | undefined,
  flag: PermissionFlag,
): boolean {
  if (!user) return false;
  return user.role === "master" || !!user[flag];
}

export interface PermissionMeta {
  key: PermissionFlag;
  label: string;
  description: string;
  group: "essentials" | "advanced" | "admin";
}

export const PERMISSION_META: PermissionMeta[] = [
  { key: "can_upload", label: "Upload files", description: "Upload files and create share links.", group: "essentials" },
  { key: "can_upload_client_encrypted", label: "End-to-end encryption", description: "Encrypt files in the browser so the server never sees the key.", group: "essentials" },
  { key: "can_delete", label: "Delete files", description: "Delete their own files.", group: "advanced" },
  { key: "can_regenerate_links", label: "Create links", description: "Mint new share links for existing files.", group: "advanced" },
  { key: "can_delete_links", label: "Delete links", description: "Remove existing share links.", group: "advanced" },
  { key: "can_create_directories", label: "Create folders", description: "Group files into shareable folders.", group: "advanced" },
  { key: "can_manage_lifecycle", label: "Lifecycle controls", description: "Set archive / expiry / idle-delete rules.", group: "advanced" },
  { key: "can_use_api_keys", label: "Personal API keys", description: "Create API keys for programmatic uploads.", group: "advanced" },
  { key: "can_use_torrents", label: "Torrent downloads", description: "Download torrents via the host's qBittorrent into their storage.", group: "advanced" },
  { key: "can_view_admin", label: "View admin", description: "Access the admin dashboard.", group: "admin" },
  { key: "can_manage_users", label: "Manage users", description: "Create, edit and delete user accounts.", group: "admin" },
  { key: "can_manage_storage", label: "Manage storage", description: "Set the global storage cap and run lifecycle jobs.", group: "admin" },
  { key: "can_manage_api_keys", label: "Manage all API keys", description: "Administer every user's API keys.", group: "admin" },
  { key: "can_manage_cluster", label: "Manage cluster", description: "Reveal/rotate the cluster token and link this server to other nodes.", group: "admin" },
];
