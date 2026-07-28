import { useRef, useState } from "react";
import { Magnet, Upload } from "lucide-react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { toast } from "sonner";
import type { AddTorrentInput, TorrentConfig } from "../types";

async function readAsBase64(file: File): Promise<string> {
  const buffer = new Uint8Array(await file.arrayBuffer());
  let binary = "";
  for (const byte of buffer) binary += String.fromCharCode(byte);
  return btoa(binary);
}

export function AddTorrentCard({
  config,
  onAdd,
  pending,
}: {
  config: TorrentConfig | undefined;
  onAdd: (input: AddTorrentInput) => Promise<unknown>;
  pending: boolean;
}) {
  const [magnet, setMagnet] = useState("");
  const fileInput = useRef<HTMLInputElement>(null);
  const disabled = !config?.configured || pending;

  const submitMagnet = async (e: React.FormEvent) => {
    e.preventDefault();
    const value = magnet.trim();
    if (!value) return;
    if (!value.startsWith("magnet:?")) {
      toast.error("That isn't a magnet link", { description: "Magnet links start with magnet:?" });
      return;
    }
    await onAdd({ magnet: value }).then(() => setMagnet(""), () => {});
  };

  const submitFile = async (file: File) => {
    const b64 = await readAsBase64(file);
    await onAdd({ torrent_file_b64: b64, filename: file.name }).catch(() => {});
    if (fileInput.current) fileInput.current.value = "";
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>Add a torrent</CardTitle>
        <CardDescription>
          {!config?.configured
            ? "Torrenting is not configured on this server yet — an admin needs to add a Real-Debrid API token or set QBITTORRENT_URL and QBITTORRENT_SAVE_PATH."
            : config.debrid_enabled
              ? "Real-Debrid downloads the torrent for you — cached or not — then the files transfer here and land in your storage automatically."
              : "qBittorrent on this host downloads the torrent, then the files land in your storage automatically."}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <form className="space-y-2" onSubmit={submitMagnet}>
          <Label htmlFor="magnet">Magnet link</Label>
          <div className="flex gap-2">
            <Input
              id="magnet"
              value={magnet}
              onChange={(e) => setMagnet(e.target.value)}
              placeholder="magnet:?xt=urn:btih:…"
              spellCheck={false}
              disabled={disabled}
            />
            <Button type="submit" loading={pending} disabled={disabled || !magnet.trim()}>
              <Magnet /> Add
            </Button>
          </div>
        </form>

        <div className="flex items-center gap-2">
          <input
            ref={fileInput}
            type="file"
            accept=".torrent,application/x-bittorrent"
            className="hidden"
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) void submitFile(file);
            }}
          />
          <Button variant="secondary" onClick={() => fileInput.current?.click()} disabled={disabled}>
            <Upload /> Upload a .torrent file
          </Button>
          {config?.configured && !config.debrid_enabled && config.save_path && (
            <span className="truncate text-xs text-muted-foreground">Downloads to {config.save_path}</span>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
