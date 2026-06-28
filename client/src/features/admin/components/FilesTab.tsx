import { useState, useMemo } from "react";
import { ChevronDown, Search, FileQuestion, Archive, ArchiveRestore, Trash2, Link2 } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Skeleton } from "@/components/ui/skeleton";
import { EmptyState } from "@/components/ui/empty-state";
import { Tooltip } from "@/components/ui/tooltip";
import { LinkList } from "@/features/files/components/LinkList";
import { iconForType, EncryptionBadge } from "@/features/files/lib/fileMeta";
import { BulkBar } from "./BulkBar";
import { BulkConfirmDialog } from "./BulkConfirmDialog";
import { useAdminFiles } from "../hooks/useAdminData";
import { useBulk } from "../hooks/useBulk";
import { useSelection } from "../hooks/useSelection";
import { useDeleteFile } from "@/features/files/hooks/useFiles";
import { useDialogs } from "@/providers/DialogProvider";
import { formatBytes } from "@/lib/bytes";
import { formatDate } from "@/lib/time";
import { cn } from "@/lib/cn";
import type { FileObject } from "@/features/files/types";

function AdminFileRow({
  file,
  selected,
  onToggle,
}: {
  file: FileObject;
  selected: boolean;
  onToggle: () => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const { archive, unarchive } = useAdminFiles();
  const del = useDeleteFile();
  const { confirm } = useDialogs();
  const Icon = iconForType(file.content_type);

  const onDelete = async () => {
    const ok = await confirm({ title: "Delete file?", description: file.original_filename, confirmText: "Delete", destructive: true });
    if (ok) del.mutate(file.id);
  };

  return (
    <Card className={cn(selected && "ring-1 ring-primary/50")}>
      <CardContent className="p-3">
        <div className="flex items-center gap-3">
          <Checkbox checked={selected} onCheckedChange={onToggle} aria-label="Select file" />
          <div className="flex size-9 shrink-0 items-center justify-center rounded-md bg-background/50">
            <Icon className="size-4 text-muted-foreground" />
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <span className="truncate text-sm font-medium" title={file.original_filename}>
                {file.original_filename}
              </span>
              <EncryptionBadge mode={file.encryption_mode} />
              {file.compressed && <Badge variant="secondary">zst</Badge>}
              {file.archived && <Badge variant="secondary">archived</Badge>}
            </div>
            <p className="text-xs text-muted-foreground">
              owner #{file.owner_id} · {formatBytes(file.size_bytes)} · {formatDate(file.created_at)}
            </p>
          </div>
          <div className="flex items-center gap-1">
            {file.archived ? (
              <Tooltip content="Unarchive">
                <Button variant="ghost" size="icon" loading={unarchive.isPending} onClick={() => unarchive.mutate(file.id)}>
                  <ArchiveRestore />
                </Button>
              </Tooltip>
            ) : (
              <Tooltip content="Archive">
                <Button variant="ghost" size="icon" loading={archive.isPending} onClick={() => archive.mutate(file.id)}>
                  <Archive />
                </Button>
              </Tooltip>
            )}
            <Tooltip content="Delete">
              <Button variant="ghost" size="icon" className="text-destructive" loading={del.isPending} onClick={onDelete}>
                <Trash2 />
              </Button>
            </Tooltip>
            <Button variant="ghost" size="sm" onClick={() => setExpanded((e) => !e)} className="gap-1">
              <Link2 className="size-4" />
              {file.links.length}
              <ChevronDown className={cn("size-4 transition-transform", expanded && "rotate-180")} />
            </Button>
          </div>
        </div>
        {expanded && (
          <div className="mt-2 border-t border-border pt-2">
            <LinkList file={file} />
          </div>
        )}
      </CardContent>
    </Card>
  );
}

export function FilesTab() {
  const { list } = useAdminFiles();
  const [filter, setFilter] = useState("");
  const selection = useSelection();
  const bulk = useBulk(selection.clear);

  const filtered = useMemo(() => {
    const q = filter.trim().toLowerCase();
    if (!q) return list.data ?? [];
    return (list.data ?? []).filter(
      (f) =>
        f.original_filename.toLowerCase().includes(q) ||
        (f.content_type ?? "").toLowerCase().includes(q) ||
        String(f.owner_id) === q ||
        String(f.id) === q,
    );
  }, [list.data, filter]);

  const allSelected = filtered.length > 0 && filtered.every((f) => selection.has(f.id));

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3">
        <div className="relative flex-1">
          <Search className="absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input className="pl-8" placeholder="Filter by filename, type, owner or id…" value={filter} onChange={(e) => setFilter(e.target.value)} />
        </div>
        {filtered.length > 0 && (
          <label className="flex shrink-0 items-center gap-2 text-sm text-muted-foreground">
            <Checkbox
              checked={allSelected}
              onCheckedChange={(v) => selection.set(filtered.map((f) => f.id), !!v)}
            />
            Select all
          </label>
        )}
      </div>

      {list.isLoading ? (
        <div className="space-y-2">
          <Skeleton className="h-16 w-full" />
          <Skeleton className="h-16 w-full" />
          <Skeleton className="h-16 w-full" />
        </div>
      ) : filtered.length === 0 ? (
        <EmptyState icon={FileQuestion} title="No files" />
      ) : (
        <div className="space-y-2 pb-16">
          {filtered.map((f) => (
            <AdminFileRow key={f.id} file={f} selected={selection.has(f.id)} onToggle={() => selection.toggle(f.id)} />
          ))}
        </div>
      )}

      <BulkBar count={selection.count} onClear={selection.clear}>
        <Button variant="ghost" size="sm" onClick={() => bulk.startPreview("archive_files", selection.list)}>
          <Archive /> Archive
        </Button>
        <Button variant="ghost" size="sm" onClick={() => bulk.startPreview("unarchive_files", selection.list)}>
          <ArchiveRestore /> Unarchive
        </Button>
        <Button variant="ghost" size="sm" className="text-destructive" onClick={() => bulk.startPreview("delete_files", selection.list)}>
          <Trash2 /> Delete
        </Button>
      </BulkBar>
      <BulkConfirmDialog bulk={bulk} />
    </div>
  );
}
