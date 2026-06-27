import { useCallback, useEffect, useState } from "react";
import { apiFetch, formatBytes } from "../lib/api";
import { Container, Eyebrow } from "../components/primitives";
import { Tabs } from "../components/Tabs";
import { OverviewTab } from "./admin/OverviewTab";
import { UsersTab } from "./admin/UsersTab";
import { FilesTab, LinkEditModal } from "./admin/FilesTab";
import { AuditTab } from "./admin/AuditTab";
import { BackendTab } from "./admin/BackendTab";
import { KeysTab } from "./admin/KeysTab";
import { DangerTab } from "./admin/DangerTab";
import type { AdminLink, Selection } from "./admin/types";

const TABS = [
  { id: "users", label: "Users" },
  { id: "details", label: "Overview" },
  { id: "files", label: "Files" },
  { id: "audit", label: "Audit log" },
  { id: "backend", label: "Backend" },
  { id: "keys", label: "API keys" },
  { id: "danger", label: "Danger zone" },
];

interface DiskStats {
  total_files: number;
  total_bytes: number;
  total_users: number;
  total_links: number;
}

function StatCard({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-[var(--radius-card)] border border-[var(--color-line)] bg-[var(--color-surface-2)]/50 p-4">
      <div className="font-[var(--font-mono)] text-[10px] uppercase tracking-wider text-[var(--color-ink-muted)]">{label}</div>
      <div className="mt-1 font-[var(--font-display)] text-2xl font-bold text-[var(--color-ink)]">{value}</div>
    </div>
  );
}

export function AdminPage() {
  const [active, setActive] = useState("users");
  const [disk, setDisk] = useState<DiskStats | null>(null);
  const [version, setVersion] = useState(0);
  const bump = useCallback(() => setVersion((v) => v + 1), []);

  const [selection, setSelection] = useState<Selection>({
    files: new Set<number>(),
    directories: new Set<number>(),
    keys: new Set<number>(),
  });
  const toggleSel = useCallback((kind: keyof Selection, id: number) => {
    setSelection((s) => {
      const next: Selection = { files: new Set(s.files), directories: new Set(s.directories), keys: new Set(s.keys) };
      if (next[kind].has(id)) next[kind].delete(id);
      else next[kind].add(id);
      return next;
    });
  }, []);
  const clearSel = useCallback((kinds: (keyof Selection)[]) => {
    setSelection((s) => {
      const next: Selection = { files: new Set(s.files), directories: new Set(s.directories), keys: new Set(s.keys) };
      for (const k of kinds) next[k] = new Set<number>();
      return next;
    });
  }, []);

  const [editLink, setEditLink] = useState<AdminLink | null>(null);

  useEffect(() => {
    (async () => {
      try {
        const resp = await apiFetch("/files/disk-stats");
        if (resp.ok) setDisk(await resp.json());
      } catch {
        /* ignore */
      }
    })();
  }, [version]);

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
