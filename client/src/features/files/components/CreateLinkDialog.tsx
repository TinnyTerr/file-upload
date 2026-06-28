import { useState } from "react";
import { Plus } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useLinks } from "../hooks/useLinks";
import { parseDuration } from "@/lib/time";

export function CreateLinkDialog({ fileId }: { fileId: number }) {
  const { mint } = useLinks();
  const [open, setOpen] = useState(false);
  const [maxUses, setMaxUses] = useState("");
  const [expiresIn, setExpiresIn] = useState("");
  const [error, setError] = useState<string | null>(null);

  const onCreate = async () => {
    setError(null);
    try {
      await mint.mutateAsync({
        fileId,
        max_uses: maxUses.trim() ? Math.max(1, parseInt(maxUses, 10)) : null,
        expires_in_seconds: expiresIn.trim() ? parseDuration(expiresIn) : null,
      });
      setOpen(false);
      setMaxUses("");
      setExpiresIn("");
    } catch (err: any) {
      setError(err.message || "Failed to create link");
    }
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="outline" size="sm">
          <Plus /> Link
        </Button>
      </DialogTrigger>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle>New share link</DialogTitle>
          <DialogDescription>Create an additional link with its own limits.</DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1.5">
            <Label htmlFor="max-uses">Max downloads</Label>
            <Input id="max-uses" type="number" min={1} placeholder="∞" value={maxUses} onChange={(e) => setMaxUses(e.target.value)} />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="expires">Expires in</Label>
            <Input id="expires" placeholder="e.g. 7d" value={expiresIn} onChange={(e) => setExpiresIn(e.target.value)} />
          </div>
        </div>
        {error && <div className="text-sm font-medium text-destructive">{error}</div>}
        <DialogFooter>
          <Button variant="ghost" onClick={() => setOpen(false)}>
            Cancel
          </Button>
          <Button onClick={onCreate} loading={mint.isPending}>
            Create link
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
