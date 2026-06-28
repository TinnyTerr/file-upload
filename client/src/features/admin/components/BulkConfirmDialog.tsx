import { useEffect, useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { UseBulk } from "../hooks/useBulk";

/** Shared preview → type-to-confirm dialog driven by a useBulk() instance. */
export function BulkConfirmDialog({ bulk }: { bulk: UseBulk }) {
  const { preview, confirm, cancel, running } = bulk;
  const [typed, setTyped] = useState("");

  useEffect(() => {
    if (preview) setTyped("");
  }, [preview]);

  const phraseOk = preview && typed.trim() === preview.data.confirmation_phrase;

  return (
    <Dialog open={!!preview} onOpenChange={(o) => !o && cancel()}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Confirm bulk action</DialogTitle>
          <DialogDescription>
            This will affect <strong>{preview?.data.affected_count}</strong> record(s) and cannot be undone.
          </DialogDescription>
        </DialogHeader>

        {preview && preview.data.items.length > 0 && (
          <div className="max-h-48 space-y-1 overflow-y-auto rounded-md border border-border bg-background/40 p-2 text-xs">
            {preview.data.items.map((it) => (
              <div key={it.id} className="truncate font-mono text-muted-foreground">
                {it.label}
              </div>
            ))}
          </div>
        )}

        <div className="space-y-1.5">
          <p className="text-sm text-muted-foreground">
            Type <code className="rounded bg-secondary px-1 font-mono">{preview?.data.confirmation_phrase}</code> to confirm.
          </p>
          <Input value={typed} onChange={(e) => setTyped(e.target.value)} placeholder={preview?.data.confirmation_phrase} autoFocus />
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={cancel}>
            Cancel
          </Button>
          <Button variant="destructive" disabled={!phraseOk} loading={running} onClick={confirm}>
            Run action
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
