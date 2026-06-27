import { formatBytes } from "../../../lib/api";
import { Container, Eyebrow } from "../../../components/ui/primitives";
import { Tabs } from "../../../components/ui/Tabs";
import { OverviewTab } from "./OverviewTab";
import { UsersTab } from "./UsersTab";
import { FilesTab, LinkEditModal } from "./FilesTab";
import { AuditTab } from "./AuditTab";
import { BackendTab } from "./BackendTab";
import { KeysTab } from "./KeysTab";
import { DangerTab } from "./DangerTab";
import { useAdminDashboard } from "../hooks/useAdminDashboard";

const TABS = [
  { id: "users", label: "Users" },
  { id: "details", label: "Overview" },
  { id: "files", label: "Files" },
  { id: "audit", label: "Audit log" },
  { id: "backend", label: "Backend" },
  { id: "keys", label: "API keys" },
  { id: "danger", label: "Danger zone" },
];

function StatCard({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-[var(--radius-card)] border border-[var(--color-line)] bg-[var(--color-surface-2)]/50 p-4">
      <div className="font-[var(--font-mono)] text-[10px] uppercase tracking-wider text-[var(--color-ink-muted)]">{label}</div>
      <div className="mt-1 font-[var(--font-display)] text-2xl font-bold text-[var(--color-ink)]">{value}</div>
    </div>
  );
}

export function AdminPage() {
  const {
    active, setActive,
    disk, version, bump,
    selection, toggleSel, clearSel,
    editLink, setEditLink,
  } = useAdminDashboard();

  return (
    <Container>
      <div className="mb-5">
        <Eyebrow>Administration</Eyebrow>
        <h1 className="font-[var(--font-display)] text-2xl font-bold text-[var(--color-ink)]">Admin</h1>
      </div>

      {disk && (
        <div className="mb-6 grid grid-cols-2 gap-3 sm:grid-cols-4">
          <StatCard label="Files" value={disk.total_files.toLocaleString()} />
          <StatCard label="Storage" value={formatBytes(disk.total_bytes)} />
          <StatCard label="Users" value={disk.total_users.toLocaleString()} />
          <StatCard label="Links" value={disk.total_links.toLocaleString()} />
        </div>
      )}

      <Tabs tabs={TABS} active={active} onChange={setActive} className="mb-6" />

      {active === "users" && <UsersTab version={version} bump={bump} />}
      {active === "details" && <OverviewTab version={version} bump={bump} />}
      {active === "files" && (
        <FilesTab
          version={version}
          bump={bump}
          selection={selection}
          toggleSel={toggleSel}
          clearSel={clearSel}
          onEditLink={setEditLink}
        />
      )}
      {active === "audit" && <AuditTab />}
      {active === "backend" && <BackendTab />}
      {active === "keys" && <KeysTab version={version} bump={bump} selection={selection} toggleSel={toggleSel} />}
      {active === "danger" && <DangerTab selection={selection} clearSel={clearSel} bump={bump} />}

      <LinkEditModal link={editLink} onClose={() => setEditLink(null)} onSaved={bump} />
    </Container>
  );
}
