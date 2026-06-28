import { useState } from "react";
import { Info, Upload } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Progress } from "@/components/ui/progress";
import { Tooltip } from "@/components/ui/tooltip";
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
} from "@/components/ui/select";
import { Dropzone } from "../Dropzone";
import { ShareModal, type ShareEntry } from "../ShareModal";
import { useFolderUpload } from "@/features/directories/hooks/useFolderUpload";
import { useAuth } from "@/features/auth/hooks/auth";
import { formatBytes } from "@/lib/bytes";
import type { EncryptionMode } from "../../types";

export function FolderMode() {
  const { can } = useAuth();
  const canCreate = can("can_create_directories");
  const canClient = can("can_upload_client_encrypted");

  const [title, setTitle] = useState("");
  const [mode, setMode] = useState<EncryptionMode>("none");
  const [files, setFiles] = useState<File[]>([]);
  const { upload, progress, busy } = useFolderUpload();
  const [shareEntry, setShareEntry] = useState<ShareEntry | null>(null);
  const [shareOpen, setShareOpen] = useState(false);

  if (!canCreate) {
    return (
      <p className="rounded-md border border-border bg-secondary/20 px-3 py-6 text-center text-sm text-muted-foreground">
        You don't have permission to create folders.
      </p>
    );
  }

  const totalBytes = files.reduce((n, f) => n + f.size, 0);

  const onUpload = async () => {
    const entry = await upload(title || "Untitled folder", mode, files);
    setFiles([]);
    setTitle("");
    if (entry) {
      setShareEntry(entry);
      setShareOpen(true);
    }
  };

  return (
    <div className="space-y-4">
      <div className="space-y-1.5">
        <Label htmlFor="folder-title">Folder title</Label>
        <Input id="folder-title" placeholder="My folder" value={title} onChange={(e) => setTitle(e.target.value)} />
      </div>

      <div className="space-y-1.5">
        <Label className="flex items-center gap-1.5">
          Encryption
          <Tooltip content="All files in the folder share this mode. Client mode uses one key (#ek=) for the whole bundle.">
            <Info className="size-3.5 text-muted-foreground" />
          </Tooltip>
        </Label>
        <Select value={mode} onValueChange={(v) => setMode(v as EncryptionMode)}>
          <SelectTrigger>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="none">None</SelectItem>
            <SelectItem value="server">Server-side (?ek=)</SelectItem>
            <SelectItem value="client" disabled={!canClient}>
              End-to-end (#ek=)
            </SelectItem>
          </SelectContent>
        </Select>
      </div>

      <Dropzone directory onFiles={setFiles} hint="Pick a folder — all files upload into one shareable bundle" />

      {files.length > 0 && (
        <p className="text-sm text-muted-foreground">
          {files.length} files · {formatBytes(totalBytes)}
        </p>
      )}

      {busy && progress && (
        <div className="space-y-1.5">
          <Progress value={Math.round(((progress.completed + progress.percent / 100) / progress.total) * 100)} />
          <p className="text-xs text-muted-foreground">
            Uploading {progress.completed + 1} of {progress.total}
            {progress.current ? ` · ${progress.current}` : ""}
          </p>
        </div>
      )}

      <Button onClick={onUpload} loading={busy} disabled={!files.length} className="w-full">
        <Upload className="mr-2" /> Upload folder
      </Button>

      <ShareModal entries={shareEntry ? [shareEntry] : []} open={shareOpen} onOpenChange={setShareOpen} />
    </div>
  );
}
