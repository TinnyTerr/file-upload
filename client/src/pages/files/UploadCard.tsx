import { useEffect, useRef } from "react";
import { Card, Eyebrow, Field, Input, ModeGroup, Toggle, Select, ProgressBar } from "../../components/primitives";
import { Button } from "../../components/Button";
import { cn } from "../../lib/cn";
import { fileIcon } from "../../lib/fileIcon";
import { formatBytes } from "../../lib/api";
import type { QueueItem } from "./uploadCore";
import type { Permissions } from "./types";

export interface UploadOptionsState {
  maxUses: string;
  expiresIn: string;
  randomize: boolean;
  encMode: string;
  compress: boolean;
  tempDays: string;
  archDays: string;
  delDays: string;
  advOpen: boolean;
}

interface Props {
  perms: Permissions;
  mode: string;
  setMode: (m: string) => void;
  queue: QueueItem[];
  addFiles: (files: File[]) => void;
  removeItem: (id: string) => void;
  clearQueue: () => void;
  startUpload: () => void;
  uploading: boolean;
  progress: { label: string; percent: number } | null;
  options: UploadOptionsState;
  setOptions: (patch: Partial<UploadOptionsState>) => void;
  // remote
  remote: { url: string; name: string; status: string; busy: boolean };
  setRemote: (patch: Partial<Props["remote"]>) => void;
  startRemote: () => void;
  // receive
  receive: { expires: string; busy: boolean; resultUrl: string };
  setReceive: (patch: Partial<Props["receive"]>) => void;
  startReceive: () => void;
}

const STATUS_RING: Record<QueueItem["status"], string> = {
  queued: "border-[var(--color-line)]",
  uploading: "border-[var(--color-accent)]/50",
  done: "border-[var(--color-good)]/40",
  error: "border-[var(--color-bad)]/50",
};

export function UploadCard(p: Props) {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const o = p.options;

  // webkitdirectory isn't a typed React prop; toggle it imperatively per mode.
  useEffect(() => {
    const el = fileInputRef.current;
    if (!el) return;
    if (p.mode === "folder") el.setAttribute("webkitdirectory", "");
    else el.removeAttribute("webkitdirectory");
  }, [p.mode]);

  const modes = [
    { value: "files", label: "Files" },
    { value: "folder", label: "Folder" },
    { value: "remote", label: "Remote" },
    { value: "receive", label: "Receive" },
  ];
  const isLocal = p.mode === "files" || p.mode === "folder";

  return (
    <Card className="reveal">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <Eyebrow>Dispatch</Eyebrow>
        <ModeGroup options={modes} value={p.mode} onChange={p.setMode} />
      </div>

      {isLocal && (
        <>
          {/* Drop zone */}
          <div
            onDragOver={(e) => {
              e.preventDefault();
              e.currentTarget.classList.add("ring-2");
            }}
            onDragLeave={(e) => e.currentTarget.classList.remove("ring-2")}
            onDrop={(e) => {
              e.preventDefault();
              e.currentTarget.classList.remove("ring-2");
              const files = Array.from(e.dataTransfer.files);
              if (files.length) p.addFiles(files);
            }}
            onClick={() => fileInputRef.current?.click()}
            className="flex cursor-pointer flex-col items-center gap-2 rounded-[var(--radius-card)] border border-dashed border-[var(--color-line-strong)] bg-[var(--color-surface-2)]/40 px-6 py-8 text-center ring-[var(--color-accent)]/40 transition hover:border-[var(--color-accent)]/60"
          >
            <div className="grid h-11 w-11 place-items-center rounded-[var(--radius-field)] bg-[var(--color-accent-soft)] text-xl">
              ↑
            </div>
            <div className="text-sm font-medium text-[var(--color-ink)]">
              {p.mode === "folder" ? "Drop a folder or click to choose" : "Drop files or click to choose"}
            </div>
            <div className="text-xs text-[var(--color-ink-muted)]">
              {p.mode === "folder"
                ? "Becomes one shared page with a download-all link"
                : "Select one or many files · encrypt and set limits below"}
            </div>
            <input
              ref={fileInputRef}
              type="file"
              hidden
              multiple
              onChange={(e) => {
                const files = Array.from(e.target.files || []);
                if (files.length) p.addFiles(files);
                e.target.value = "";
              }}
            />
          </div>

          {/* Queue */}
          {p.queue.length > 0 && (
            <div className="mt-3 flex flex-col gap-2">
              {p.queue.map((item) => {
                const display =
                  p.mode === "folder" && item.file.webkitRelativePath
                    ? item.file.webkitRelativePath
                    : item.file.name;
                return (
                  <div
                    key={item.id}
                    className={cn(
                      "rounded-[var(--radius-field)] border bg-[var(--color-surface-2)] px-3 py-2",
                      STATUS_RING[item.status],
                    )}
                  >
                    <div className="flex items-center gap-2.5">
                      <span className="text-base">{fileIcon(item.file.type)}</span>
                      <span className="min-w-0 flex-1 truncate text-sm text-[var(--color-ink)]" title={display}>
                        {display}
                      </span>
                      <span className="shrink-0 font-[var(--font-mono)] text-xs text-[var(--color-ink-muted)]">
                        {formatBytes(item.file.size)}
                      </span>
                      {item.status === "uploading" && (
                        <span className="shrink-0 font-[var(--font-mono)] text-xs text-[var(--color-accent)]">
                          {item.progress}%
                        </span>
                      )}
                      {item.status === "done" && (
                        <span className="shrink-0 text-xs text-[var(--color-good)]">✓ done</span>
                      )}
                      {item.status === "error" && (
                        <span className="shrink-0 text-xs text-[var(--color-bad)]">✕ failed</span>
                      )}
                      {item.status !== "uploading" && item.status !== "done" && (
                        <button
                          type="button"
                          onClick={() => p.removeItem(item.id)}
                          className="shrink-0 text-[var(--color-ink-muted)] hover:text-[var(--color-bad)]"
                          title="Remove"
                        >
                          ✕
                        </button>
                      )}
                    </div>
                    {item.status === "uploading" && (
                      <div className="mt-1.5">
                        <ProgressBar percent={item.progress} />
                      </div>
                    )}
                    {item.status === "error" && item.error && (
                      <div className="mt-1 text-xs text-[var(--color-bad)]">{item.error}</div>
                    )}
                  </div>
                );
              })}
            </div>
          )}

          {/* Options */}
          <div className="mt-4 rounded-[var(--radius-field)] border border-[var(--color-line)] bg-[var(--color-surface-2)]/40 p-3">
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Max downloads">
                <Input
                  placeholder="unlimited"
                  value={o.maxUses}
                  onChange={(e) => p.setOptions({ maxUses: e.target.value })}
                />
              </Field>
              <Field label="Expires in">
                <Input
                  placeholder='e.g. "7d", "24h"'
                  value={o.expiresIn}
                  onChange={(e) => p.setOptions({ expiresIn: e.target.value })}
                />
              </Field>
            </div>
            <div className="mt-2 grid gap-3 sm:grid-cols-2">
              <Field label="Encryption">
                <Select value={o.encMode} onChange={(e) => p.setOptions({ encMode: e.target.value })}>
                  <option value="none">None</option>
                  <option value="server">Server-side (?ek=)</option>
                  {p.perms.canUploadClientEncrypted && (
                    <option value="client">End-to-end (#ek=)</option>
                  )}
                </Select>
              </Field>
              <div className="flex items-end gap-4 pb-1">
                <Toggle
                  checked={o.randomize}
                  onChange={(v) => p.setOptions({ randomize: v })}
                  label="Random name"
                />
                <Toggle
                  checked={o.compress}
                  onChange={(v) => p.setOptions({ compress: v })}
                  label="Compress"
                />
              </div>
            </div>

            <button
              type="button"
              onClick={() => p.setOptions({ advOpen: !o.advOpen })}
              className="mt-2 flex items-center gap-1.5 text-xs font-medium text-[var(--color-ink-muted)] hover:text-[var(--color-ink-dim)]"
            >
              <span className={cn("transition-transform", o.advOpen && "rotate-90")}>▸</span>
              Advanced lifecycle
            </button>
            {o.advOpen && (
              <div className="mt-2 grid gap-3 sm:grid-cols-3">
                <Field label="Delete after (days)">
                  <Input value={o.tempDays} onChange={(e) => p.setOptions({ tempDays: e.target.value })} />
                </Field>
                <Field label="Archive if idle (days)">
                  <Input value={o.archDays} onChange={(e) => p.setOptions({ archDays: e.target.value })} />
                </Field>
                <Field label="Delete if idle (days)">
                  <Input value={o.delDays} onChange={(e) => p.setOptions({ delDays: e.target.value })} />
                </Field>
              </div>
            )}
          </div>

          {progressBlock(p)}

          <div className="mt-4 flex items-center gap-2">
            <Button
              onClick={p.startUpload}
              disabled={p.uploading || p.queue.every((i) => i.status !== "queued")}
            >
              {p.uploading ? "Uploading…" : p.mode === "folder" ? "Share folder" : "Upload"}
            </Button>
            {p.queue.some((i) => i.status !== "uploading") && (
              <Button variant="ghost" onClick={p.clearQueue} disabled={p.uploading}>
                Clear
              </Button>
            )}
          </div>
        </>
      )}

      {p.mode === "remote" && (
        <div className="space-y-3">
          <Field label="Remote URL">
            <Input
              placeholder="https://example.com/file.zip"
              value={p.remote.url}
              onChange={(e) => p.setRemote({ url: e.target.value })}
            />
          </Field>
          <Field label="Filename (optional)">
            <Input
              placeholder="report.pdf"
              value={p.remote.name}
              onChange={(e) => p.setRemote({ name: e.target.value })}
            />
          </Field>
          <div className="flex items-center gap-3">
            <Button onClick={p.startRemote} disabled={p.remote.busy}>
              {p.remote.busy ? "Fetching…" : "Start remote upload"}
            </Button>
            {p.remote.status && (
              <span className="text-sm text-[var(--color-ink-muted)]">{p.remote.status}</span>
            )}
          </div>
        </div>
      )}

      {p.mode === "receive" && (
        <div className="space-y-3">
          <p className="text-sm text-[var(--color-ink-dim)]">
            Create a one-time upload link to receive a file from someone else. It disables after the
            first upload.
          </p>
          <Field label="Expires after">
            <Input
              placeholder="1h"
              value={p.receive.expires}
              onChange={(e) => p.setReceive({ expires: e.target.value })}
            />
          </Field>
          <Button onClick={p.startReceive} disabled={p.receive.busy}>
            {p.receive.busy ? "Creating…" : "Create upload link"}
          </Button>
          {p.receive.resultUrl && (
            <div className="flex items-center gap-2 rounded-[var(--radius-field)] border border-[var(--color-line)] bg-[var(--color-surface-2)] p-1.5 pl-3">
              <span className="min-w-0 flex-1 truncate font-[var(--font-mono)] text-[13px] text-[var(--color-ink-dim)]">
                {p.receive.resultUrl}
              </span>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => navigator.clipboard.writeText(p.receive.resultUrl).catch(() => {})}
              >
                Copy
              </Button>
            </div>
          )}
        </div>
      )}
    </Card>
  );
}

function progressBlock(p: Props) {
  if (!p.progress) return null;
  return (
    <div className="mt-4">
      <div className="mb-1 text-xs text-[var(--color-ink-muted)]">{p.progress.label}</div>
      <ProgressBar percent={p.progress.percent} />
    </div>
  );
}
