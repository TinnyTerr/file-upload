import { useState } from "react";
import { Upload, Trash2, FileIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dropzone } from "../Dropzone";
import { UploadOptionsForm, defaultFormState, toUploadOptions, type UploadFormState } from "../UploadOptionsForm";
import { UploadQueue } from "../UploadQueue";
import { ShareModal, type ShareEntry } from "../ShareModal";
import { useUpload } from "../../hooks/useUpload";
import { outcomeToShareEntry } from "../../lib/shareMapping";
import { formatBytes } from "@/lib/bytes";

export function FilesMode() {
  const [files, setFiles] = useState<File[]>([]);
  const [form, setForm] = useState<UploadFormState>(defaultFormState);
  const { items, busy, start, cancel, clearFinished } = useUpload();
  const [shareEntries, setShareEntries] = useState<ShareEntry[]>([]);
  const [shareOpen, setShareOpen] = useState(false);

  const onUpload = async () => {
    const results = await start(files, toUploadOptions(form));
    setFiles([]);
    if (results.length) {
      setShareEntries(results.map((r) => outcomeToShareEntry(r.filename, r.outcome)).filter((e): e is ShareEntry => e !== null));
      setShareOpen(true);
    }
  };

  return (
    <div className="space-y-4">
      <Dropzone
        onFiles={(f) => setFiles((prev) => [...prev, ...f])}
        hint="Select multiple files at once — up to your per-file size limit each"
      />

      {files.length > 0 && (
        <>
          <ul className="space-y-1.5">
            {files.map((f, i) => (
              <li key={`${f.name}-${i}`} className="flex items-center justify-between gap-2 rounded-md border border-border bg-secondary/20 px-3 py-2 text-sm">
                <span className="flex min-w-0 items-center gap-2">
                  <FileIcon className="size-4 shrink-0 text-muted-foreground" />
                  <span className="truncate">{f.name}</span>
                </span>
                <span className="flex items-center gap-2 text-xs text-muted-foreground">
                  {formatBytes(f.size)}
                  <Button
                    variant="ghost"
                    size="icon"
                    className="size-6"
                    onClick={() => setFiles((prev) => prev.filter((_, idx) => idx !== i))}
                  >
                    <Trash2 className="size-3.5" />
                  </Button>
                </span>
              </li>
            ))}
          </ul>

          <UploadOptionsForm value={form} onChange={setForm} />

          <Button onClick={onUpload} loading={busy} className="w-full">
            <Upload className="mr-2" /> Upload {files.length} file{files.length > 1 ? "s" : ""}
          </Button>
        </>
      )}

      {items.length > 0 && (
        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <span className="text-sm font-medium">Transfers</span>
            {!busy && (
              <Button variant="ghost" size="sm" onClick={clearFinished}>
                Clear finished
              </Button>
            )}
          </div>
          <UploadQueue items={items} onCancel={cancel} />
        </div>
      )}

      <ShareModal entries={shareEntries} open={shareOpen} onOpenChange={setShareOpen} />
    </div>
  );
}
