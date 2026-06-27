import { useState } from "react";
import { useToast } from "../../../providers/ToastProvider";
import { useDialog } from "../../../providers/DialogProvider";
import { Card } from "../../../components/ui/primitives";
import { Button } from "../../../components/ui/Button";
import { bulkPreview, bulkRun } from "../services/adminService";
import type { Selection } from "../types";

interface BulkMeta {
  action: string;
  title: string;
  noun: string;
  description: string;
  selectedKind?: "files" | "directories";
}

const BULK: BulkMeta[] = [
  { action: "delete_inactive_links", title: "Delete inactive links", noun: "link", description: "Inactive, expired, and used-up links will be permanently removed. Files remain stored." },
  { action: "revoke_api_keys", title: "Revoke API keys", noun: "API key", description: "Selected active keys are used when any are checked; otherwise all active keys are previewed." },
  { action: "reset_api_key_ips", title: "Reset key IP bindings", noun: "API key", description: "Selected bound keys are used when any are checked; otherwise all bound keys are previewed." },
  { action: "archive_files", title: "Archive selected files", noun: "file", selectedKind: "files", description: "Selected eligible files will be archived/compressed." },
  { action: "unarchive_files", title: "Unarchive selected files", noun: "file", selectedKind: "files", description: "Selected archived files will be restored after quota and disk checks." },
  { action: "delete_files", title: "Delete selected files", noun: "file", selectedKind: "files", description: "Selected files and their links will be permanently removed." },
  { action: "delete_directories", title: "Delete selected folders", noun: "folder", selectedKind: "directories", description: "Selected folders and every file inside them will be permanently removed." },
  { action: "run_cleanup_jobs", title: "Run cleanup jobs", noun: "job", description: "Temp expiry, idle deletion, link expiry, and lifecycle reconciliation will run now." },
];

interface Props {
  selection: Selection;
  clearSel: (kinds: (keyof Selection)[]) => void;
  bump: () => void;
}

export function DangerTab({ selection, clearSel, bump }: Props) {
  const { showToast } = useToast();
  const dialog = useDialog();
  const [busy, setBusy] = useState("");
  const [result, setResult] = useState<{ title: string; processed: number; affected: number } | null>(null);

  function idsFor(meta: BulkMeta): number[] {
    if (meta.selectedKind === "files") return [...selection.files];
    if (meta.selectedKind === "directories") return [...selection.directories];
    if (["revoke_api_keys", "reset_api_key_ips"].includes(meta.action) && selection.keys.size) return [...selection.keys];
    return [];
  }

  async function run(meta: BulkMeta) {
    const ids = idsFor(meta);
    if (meta.selectedKind && !ids.length) return showToast("Select rows in the Files tab first.", "error");

    setBusy(meta.action);
    let preview;
    try {
      preview = await bulkPreview(meta.action, ids);
    } catch (err) {
      return showToast((err as Error).message || "Bulk preview failed.", "error");
    } finally {
      setBusy("");
    }
    if (!preview.affected_count) return showToast("No matching records for that bulk action.");

    const phrase = preview.confirmation_phrase;
    const typed = await dialog.prompt({
      title: meta.title,
      message: `${meta.description}\n\nThis will affect ${preview.affected_count} ${meta.noun}${preview.affected_count !== 1 ? "s" : ""}. Type ${phrase} to run it.`,
      placeholder: phrase,
      confirmText: "Run action",
      glyph: "!",
    });
    if (typed === null) return;
    if (typed !== phrase) return showToast("Confirmation phrase did not match.", "error");

    setBusy(meta.action);
    let res;
    try {
      res = await bulkRun(meta.action, ids, phrase);
    } catch (err) {
      return showToast((err as Error).message || "Bulk action failed.", "error");
    } finally {
      setBusy("");
    }
    setResult({ title: meta.title, processed: res.processed_count, affected: res.affected_count });
    showToast(`${meta.title}: processed ${res.processed_count}.`);
    if (["delete_files", "archive_files", "unarchive_files"].includes(meta.action)) clearSel(["files"]);
    if (meta.action === "delete_directories") clearSel(["directories"]);
    if (["revoke_api_keys", "reset_api_key_ips"].includes(meta.action)) clearSel(["keys"]);
    bump();
  }

  return (
    <div className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-2">
        {BULK.map((meta) => {
          const ids = idsFor(meta);
          const requiresSelection = !!meta.selectedKind;
          const disabled = (requiresSelection && !ids.length) || busy === meta.action;
          let sub = meta.description;
          if (requiresSelection) {
            const label = meta.selectedKind === "directories" ? "folder" : "file";
            sub = ids.length
              ? `${ids.length} selected ${label}${ids.length !== 1 ? "s" : ""}.`
              : `Requires checked ${label}s in the Files tab.`;
          } else if (["revoke_api_keys", "reset_api_key_ips"].includes(meta.action) && ids.length) {
            sub = `${ids.length} selected key${ids.length !== 1 ? "s" : ""}.`;
          }
          return (
            <Card key={meta.action} className="flex flex-col gap-2 border-[var(--color-bad)]/25">
              <div className="font-[var(--font-display)] font-semibold text-[var(--color-ink)]">{meta.title}</div>
              <div className="flex-1 text-xs text-[var(--color-ink-muted)]">{sub}</div>
              <Button variant="danger" disabled={disabled} onClick={() => run(meta)} className="self-start">
                {busy === meta.action ? "Working…" : "Run"}
              </Button>
            </Card>
          );
        })}
      </div>

      {result && (
        <Card>
          <div className="font-[var(--font-display)] font-semibold text-[var(--color-ink)]">{result.title}</div>
          <div className="text-sm text-[var(--color-ink-muted)]">
            Processed {result.processed} of {result.affected} previewed item(s).
          </div>
        </Card>
      )}
    </div>
  );
}
