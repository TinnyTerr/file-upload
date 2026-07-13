import { FolderUp, BookText, ShieldCheck, KeyRound, Network, type LucideIcon } from "lucide-react";
import type { PermissionFlag } from "./permissions";
import type { FeatureFlag } from "./featureFlags";

export interface NavItem {
  label: string;
  to: string;
  icon: LucideIcon;
  description: string;
  /** If set, item only shows when the current user has this permission. */
  requires?: PermissionFlag;
  /** If set, item only shows once this backend feature has been ported to server/. */
  feature?: FeatureFlag;
}

export const NAV_ITEMS: NavItem[] = [
  {
    label: "Files",
    to: "/files",
    icon: FolderUp,
    description: "Upload, share and manage your files",
    feature: "files",
  },
  {
    label: "Keys",
    to: "/api-keys",
    icon: KeyRound,
    description: "Manage your API keys",
    requires: "can_use_api_keys",
    feature: "keys",
  },
  {
    label: "API",
    to: "/api-docs",
    icon: BookText,
    description: "Programmatic upload reference",
    requires: "can_use_api_keys",
  },
  {
    label: "Cluster",
    to: "/cluster",
    icon: Network,
    description: "Link nodes and manage cluster tokens",
    requires: "can_manage_cluster",
    feature: "cluster",
  },
  {
    label: "Admin",
    to: "/admin",
    icon: ShieldCheck,
    description: "Users, storage and audit controls",
    requires: "can_view_admin",
    feature: "admin",
  },
];
