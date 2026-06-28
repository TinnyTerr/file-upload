import { useState } from "react";
import { Eye, EyeOff, Info, Power, PowerOff, Trash2 } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Tooltip } from "@/components/ui/tooltip";
import { ShareModal, type ShareEntry } from "./ShareModal";
import { useLinks } from "../hooks/useLinks";
import { useDialogs } from "@/providers/DialogProvider";
import { fileUrl, shareUrl } from "../lib/shareUrl";
import { formatDateTime } from "@/lib/time";
import type { FileObject, FileLink } from "../types";

function linkStatus(link: FileLink): { label: string; variant: "success" | "secondary" | "warning" | "destructive" } {
  if (!link.active) return { label: "inactive", variant: "secondary" };
  if (link.expires_at && new Date(link.expires_at) < new Date()) return { label: "expired", variant: "warning" };
  if (link.max_uses != null && link.use_count >= link.max_uses) return { label: "used up", variant: "destructive" };
  return { label: "active", variant: "success" };
}

export function LinkList({ file }: { file: FileObject }) {
  const { edit, remove } = useLinks();
  const { confirm } = useDialogs();
  const [infoEntry, setInfoEntry] = useState<ShareEntry | null>(null);

  if (!file.links.length) {
    return <p className="px-1 py-2 text-xs text-muted-foreground">No links yet.</p>;
  }

  const onDelete = async (link: FileLink) => {
    const ok = await confirm({
      title: "Delete link?",
      description: "This permanently removes the share link.",
      confirmText: "Delete",
      destructive: true,
    });
    if (ok) remove.mutate(link.id);
  };

  const openInfo = (link: FileLink) => {
    setInfoEntry({
      filename: file.original_filename,
      mode: file.encryption_mode,
      baseUrl: fileUrl(link.slug),
      accessKey: file.access_key,
      clientKeyB64: null,
    });
  };

  return (
    <>
      <ul className="space-y-2">
        {file.links.map((link) => {
          // Server-mode keys are recoverable (file.access_key); client keys are
          // never stored, so the preview shows the bare URL (owner appends #ek=).
          const base = fileUrl(link.slug);
          const url = shareUrl(base, file.encryption_mode, { accessKey: file.access_key, clientKeyB64: null });
          const status = linkStatus(link);
          return (
            <li key={link.id} className="rounded-md border border-border bg-background/30 p-2.5">
              <div className="flex items-center gap-2">
                <code className="flex-1 truncate font-mono text-xs">{url}</code>
                <Badge variant={status.variant}>{status.label}</Badge>
              </div>
              <div className="mt-1.5 flex flex-wrap items-center justify-between gap-2">
                <div className="flex items-center gap-3 text-xs text-muted-foreground">
                  <span>
                    {link.use_count}
                    {link.max_uses != null ? ` / ${link.max_uses}` : " / ∞"} downloads
                    {link.expires_at ? ` · expires ${formatDateTime(link.expires_at)}` : ""}
                  </span>
                  {link.hide_uploader && (
                    <span className="flex items-center gap-1">
                      <EyeOff className="size-3" /> anon
                    </span>
                  )}
                </div>
                <div className="flex items-center gap-0.5">
                  <Tooltip content="File info & share">
                    <Button variant="ghost" size="sm" onClick={() => openInfo(link)} className="gap-1.5">
                      <Info /> Info
                    </Button>
                  </Tooltip>
                  <Tooltip content={link.hide_uploader ? "Show uploader" : "Hide uploader"}>
                    <Button variant="ghost" size="icon" onClick={() => edit.mutate({ linkId: link.id, hide_uploader: !link.hide_uploader })}>
                      {link.hide_uploader ? <Eye /> : <EyeOff />}
                    </Button>
                  </Tooltip>
                  <Tooltip content={link.active ? "Deactivate" : "Reactivate"}>
                    <Button variant="ghost" size="icon" onClick={() => edit.mutate({ linkId: link.id, active: !link.active })}>
                      {link.active ? <PowerOff /> : <Power />}
                    </Button>
                  </Tooltip>
                  <Tooltip content="Delete link">
                    <Button variant="ghost" size="icon" className="text-destructive" onClick={() => onDelete(link)}>
                      <Trash2 />
                    </Button>
                  </Tooltip>
                </div>
              </div>
            </li>
          );
        })}
      </ul>

      <ShareModal
        entries={infoEntry ? [infoEntry] : []}
        open={!!infoEntry}
        onOpenChange={(o) => !o && setInfoEntry(null)}
        title="File info"
        description="Share links, key and download details for this file."
      />
    </>
  );
}
