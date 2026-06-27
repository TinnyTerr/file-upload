import { useCallback, useEffect, useState } from "react";
import { fetchDiskStats, type DiskStats } from "../services/adminService";
import type { AdminLink, Selection } from "../types";

/** Top-level admin state: disk stats, a refresh "version" bus, cross-tab
 *  selection, and the link-edit modal target. */
export function useAdminDashboard() {
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
    fetchDiskStats()
      .then(setDisk)
      .catch(() => {
        /* ignore */
      });
  }, [version]);

  return {
    active, setActive,
    disk, version, bump,
    selection, toggleSel, clearSel,
    editLink, setEditLink,
  };
}
