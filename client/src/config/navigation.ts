import { FolderUp, BookText, ShieldCheck, KeyRound, type LucideIcon } from "lucide-react";
import type { PermissionFlag } from "./permissions";

export interface NavItem {
  label: string;
  to: string;
  icon: LucideIcon;
  description: string;
  /** If set, item only shows when the current user has this permission. */
  requires?: PermissionFlag;
}

export const NAV_ITEMS: NavItem[] = [
  {
    label: "Files",
    to: "/files",
    icon: FolderUp,
    description: "Upload, share and manage your files",
  },
  {
    label: "Keys",
    to: "/api-keys",
    icon: KeyRound,
    description: "Manage your API keys",
    requires: "can_use_api_keys",
  },
  {
    label: "API",
    to: "/api-docs",
    icon: BookText,
    description: "Programmatic upload reference",
    requires: "can_use_api_keys",
  },
  {
    label: "Admin",
    to: "/admin",
    icon: ShieldCheck,
    description: "Users, storage and audit controls",
    requires: "can_view_admin",
  },
];
