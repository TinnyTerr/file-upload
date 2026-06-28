import type { PermissionFlag } from "@/config/permissions";

export type Role = "master" | "user";

/** Shape returned by GET /account/me. */
export interface CurrentUser extends Record<PermissionFlag, boolean> {
  id: number;
  username: string;
  role: Role;
  has_avatar: boolean;
  quota_bytes: number;
  max_file_bytes: number;
  used_bytes: number;
  must_change_credentials?: boolean;
}
