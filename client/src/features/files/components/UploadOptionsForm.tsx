import { useState } from "react";
import { ChevronDown, Info } from "lucide-react";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Tooltip } from "@/components/ui/tooltip";
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
} from "@/components/ui/select";
import { parseDuration } from "@/lib/time";
import { cn } from "@/lib/cn";
import { useAuth } from "@/features/auth/hooks/auth";
import { useDirectories } from "@/features/directories/hooks/useDirectories";
import type { EncryptionMode, UploadOptions } from "../types";

export interface UploadFormState {
  encryption_mode: EncryptionMode;
  directory_id: string;
  maxDownloads: string;
  expiresIn: string;
  randomize_filename: boolean;
  compress: boolean;
  // lifecycle
  temp_days: string;
  archive_after_idle_days: string;
  delete_if_idle_days: string;
}

export const defaultFormState: UploadFormState = {
  encryption_mode: "none",
  directory_id: "none",
  maxDownloads: "",
  expiresIn: "",
  randomize_filename: false,
  compress: false,
  temp_days: "",
  archive_after_idle_days: "",
  delete_if_idle_days: "",
};

/** Translate the form into the wire-level UploadOptions. */
export function toUploadOptions(s: UploadFormState): UploadOptions {
  const num = (v: string) => (v.trim() ? Math.max(1, parseInt(v, 10)) : null);
  const expires = s.expiresIn.trim() ? parseDuration(s.expiresIn) : null;
  const temp = num(s.temp_days);
  const idleDel = num(s.delete_if_idle_days);
  const idleArc = num(s.archive_after_idle_days);
  const lifecycle = temp !== null || idleDel !== null || idleArc !== null;
  return {
    encryption_mode: s.encryption_mode,
    max_uses: num(s.maxDownloads),
    expires_in_seconds: expires,
    randomize_filename: s.randomize_filename,
    compress: s.compress && s.encryption_mode !== "client",
    is_permanent: !lifecycle,
    temp_days: temp,
    delete_if_idle_days: idleDel,
    archive_after_idle_days: idleArc,
    directory_id: s.directory_id !== "none" ? parseInt(s.directory_id, 10) : null,
  };
}

function Row({ label, hint, children }: { label: string; hint: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-3 py-1">
      <Label className="flex items-center gap-1.5">
        {label}
        <Tooltip content={hint}>
          <Info className="size-3.5 text-muted-foreground" />
        </Tooltip>
      </Label>
      {children}
    </div>
  );
}

export function UploadOptionsForm({
  value,
  onChange,
  allowLifecycle = true,
}: {
  value: UploadFormState;
  onChange: (s: UploadFormState) => void;
  allowLifecycle?: boolean;
}) {
  const { can } = useAuth();
  const { data: directories } = useDirectories();
  const [showAdvanced, setShowAdvanced] = useState(false);
  const set = <K extends keyof UploadFormState>(k: K, v: UploadFormState[K]) => onChange({ ...value, [k]: v });

  const canClient = can("can_upload_client_encrypted");
  const canLifecycle = allowLifecycle && can("can_manage_lifecycle");

  return (
    <div className="space-y-3 rounded-lg border border-border bg-secondary/20 p-4">
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <div className="space-y-1.5">
          <Label className="flex items-center gap-1.5">
            Encryption
            <Tooltip content="none: anyone with the link downloads. server: a ?ek= key gates download. client: end-to-end, key never leaves your browser.">
              <Info className="size-3.5 text-muted-foreground" />
            </Tooltip>
          </Label>
          <Select value={value.encryption_mode} onValueChange={(v) => set("encryption_mode", v as EncryptionMode)}>
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="none">None — link is the credential</SelectItem>
              <SelectItem value="server">Server-side (?ek=)</SelectItem>
              <SelectItem value="client" disabled={!canClient}>
                End-to-end (#ek=){!canClient ? " — not permitted" : ""}
              </SelectItem>
            </SelectContent>
          </Select>
        </div>

        <div className="space-y-1.5">
          <Label className="flex items-center gap-1.5">
            Folder
            <Tooltip content="Upload these files directly into a specific folder.">
              <Info className="size-3.5 text-muted-foreground" />
            </Tooltip>
          </Label>
          <Select value={value.directory_id} onValueChange={(v) => set("directory_id", v)}>
            <SelectTrigger>
              <SelectValue placeholder="Select a folder..." />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="none">None — upload loosely</SelectItem>
              {directories?.map((dir) => (
                <SelectItem key={dir.id} value={dir.id.toString()}>
                  {dir.title}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <div className="space-y-1.5">
          <Label className="flex items-center gap-1.5">
            Max downloads
            <Tooltip content="Link stops working after this many downloads. Blank = unlimited.">
              <Info className="size-3.5 text-muted-foreground" />
            </Tooltip>
          </Label>
          <Input
            type="number"
            min={1}
            placeholder="∞"
            value={value.maxDownloads}
            onChange={(e) => set("maxDownloads", e.target.value)}
          />
        </div>
        <div className="space-y-1.5">
          <Label className="flex items-center gap-1.5">
            Expires in
            <Tooltip content="Duration like 24h, 7d, 30m. Blank = never expires.">
              <Info className="size-3.5 text-muted-foreground" />
            </Tooltip>
          </Label>
          <Input placeholder="e.g. 7d" value={value.expiresIn} onChange={(e) => set("expiresIn", e.target.value)} />
        </div>
      </div>

      <Row label="Random filename" hint="Downloaders see a randomized name instead of the original.">
        <Switch checked={value.randomize_filename} onCheckedChange={(v) => set("randomize_filename", v)} />
      </Row>
      <Row label="Compress" hint="zstd-compress before storing (skipped for already-compressed types and client encryption).">
        <Switch
          checked={value.compress}
          disabled={value.encryption_mode === "client"}
          onCheckedChange={(v) => set("compress", v)}
        />
      </Row>

      {canLifecycle && (
        <div className="border-t border-border pt-2">
          <button
            type="button"
            onClick={() => setShowAdvanced((s) => !s)}
            className="flex w-full items-center justify-between text-sm font-medium text-muted-foreground transition-colors hover:text-foreground"
          >
            Advanced lifecycle
            <ChevronDown className={cn("size-4 transition-transform", showAdvanced && "rotate-180")} />
          </button>
          {showAdvanced && (
            <div className="mt-2 grid grid-cols-1 sm:grid-cols-3 gap-2">
              <div className="space-y-1">
                <Label className="text-xs">Delete after (days)</Label>
                <Input type="number" min={1} value={value.temp_days} onChange={(e) => set("temp_days", e.target.value)} />
              </div>
              <div className="space-y-1">
                <Label className="text-xs">Archive if idle</Label>
                <Input
                  type="number"
                  min={1}
                  value={value.archive_after_idle_days}
                  onChange={(e) => set("archive_after_idle_days", e.target.value)}
                />
              </div>
              <div className="space-y-1">
                <Label className="text-xs">Delete if idle</Label>
                <Input
                  type="number"
                  min={1}
                  value={value.delete_if_idle_days}
                  onChange={(e) => set("delete_if_idle_days", e.target.value)}
                />
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
