// Centralized app navigation. Expanding the top nav is as simple as adding an
// entry here — no edits to the Nav component itself.

export interface NavItem {
  to: string;
  label: string;
  /** Pathname prefix used to mark the link active. */
  match: string;
  /** When true, only shown to master/admin users. */
  master?: boolean;
}

export const NAV_LINKS: NavItem[] = [
  { to: "/files", label: "Files", match: "/files" },
  { to: "/api-docs", label: "API", match: "/api-docs" },
  { to: "/admin", label: "Admin", match: "/admin", master: true },
];
