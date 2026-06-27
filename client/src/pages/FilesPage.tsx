import { useCallback, useEffect, useRef, useState } from "react";
import { apiFetch, formatBytes, parseDuration } from "../lib/api";
import {
  b64urlEncode,
  directoryShareUrl,
  extractEk,
  b64urlDecodeBytes,
  fullShareUrl,
  type UploadResult,
} from "../lib/keys";
import { useToast } from "../providers/ToastProvider";
import { useDialog } from "../providers/DialogProvider";
import { Container, Card, Eyebrow, Field, Input, Select, ProgressBar } from "../components/primitives";
import { Button } from "../components/Button";
import { Modal } from "../components/Modal";
import { UploadCard, type UploadOptionsState } from "./files/UploadCard";
import { FilesList, type FilesActions } from "./files/FilesList";
import { ApiKeysSection } from "./files/ApiKeysSection";
import { ShareModal, type ShareSpec } from "./files/ShareModal";
import { qId, uploadOne, type QueueItem, type UploadOpts } from "./files/uploadCore";
import type { DirObj, FileObj, LinkObj, Permissions } from "./files/types";

const DEFAULT_PERMS: Permissions = {
  canRegenerateLinks: false,
  canUseApiKeys: false,
  canDeleteFiles: false,
  canDeleteLinks: false,
  canCreateDirectories: false,
  canUploadClientEncrypted: false,
};

const DEFAULT_OPTS: UploadOptionsState = {
  maxUses: "",
  expiresIn: "",
  randomize: false,
  encMode: "none",
  compress: false,
  tempDays: "",
  archDays: "",
  delDays: "",
  advOpen: false,
};

export function FilesPage() {
  const { showToast } = useToast();
  const dialog = useDialog();

  const [usage, setUsage] = useState<{ used: number; quota: number } | null>(null);
  const [perms, setPerms] = useState<Permissions>(DEFAULT_PERMS);
  const [mode, setMode] = useState("files");
  const [queue, setQueue] = useState<QueueItem[]>([]);
  const queueRef = useRef<QueueItem[]>([]);
  queueRef.current = queue;

  const [options, setOptionsState] = useState<UploadOptionsState>(DEFAULT_OPTS);
  const setOptions = (patch: Partial<UploadOptionsState>) => setOptionsState((o) => ({ ...o, ...patch }));

  const [dirs, setDirs] = useState<DirObj[]>([]);
  const [files, setFiles] = useState<FileObj[]>([]);
  const [listLoading, setListLoading] = useState(true);

  const [uploading, setUploading] = useState(false);
  const [progress, setProgress] = useState<{ label: string; percent: number } | null>(null);

  const [remote, setRemoteState] = useState({ url: "", name: "", status: "", busy: false });
  const setRemote = (patch: Partial<typeof remote>) => setRemoteState((r) => ({ ...r, ...patch }));
  const [receive, setReceiveState] = useState({ expires: "1h", busy: false, resultUrl: "" });
  const setReceive = (patch: Partial<typeof receive>) => setReceiveState((r) => ({ ...r, ...patch }));

  const [shareSpec, setShareSpec] = useState<ShareSpec | null>(null);
  const [mintFileId, setMintFileId] = useState<number | null>(null);
  const [mintFields, setMintFields] = useState({ maxUses: "", expires: "" });
  const [dirModalOpen, setDirModalOpen] = useState(false);
  const [dirFields, setDirFields] = useState({ title: "", encMode: "none", expires: "" });

  // ── Data loading ─────────────────────────────────────────────────────────
  const loadUsage = useCallback(async () => {
    try {
      const resp = await apiFetch("/files/usage");
      if (!resp.ok) return;
      const { used_bytes, quota_bytes } = await resp.json();
      setUsage({ used: used_bytes, quota: quota_bytes });
    } catch {
      /* ignore */
    }
  }, []);

  const loadFiles = useCallback(async () => {
    setListLoading(true);
    try {
      const [fResp, dResp] = await Promise.all([apiFetch("/files/"), apiFetch("/directories/")]);
      setFiles(fResp.ok ? (await fResp.json()).files : []);
      setDirs(dResp.ok ? (await dResp.json()).directories : []);
    } finally {
      setListLoading(false);
    }
  }, []);

  useEffect(() => {
    (async () => {
      try {
        const resp = await apiFetch("/account/me");
        if (resp.ok) {
          const me = await resp.json();
          setPerms({
            canRegenerateLinks: !!me.can_regenerate_links,
            canUseApiKeys: !!me.can_use_api_keys,
            canDeleteFiles: !!me.can_delete,
            canDeleteLinks: !!me.can_delete_links,
            canCreateDirectories: !!me.can_create_directories,
            canUploadClientEncrypted: !!me.can_upload_client_encrypted,
          });
        }
      } catch {
        /* ignore */
      }
      loadUsage();
      loadFiles();
    })();
  }, [loadUsage, loadFiles]);

  // ── Queue helpers ────────────────────────────────────────────────────────
  const patchItem = (id: string, patch: Partial<QueueItem>) =>
    setQueue((q) => q.map((i) => (i.id === id ? { ...i, ...patch } : i)));

  const addFiles = (incoming: File[]) =>
    setQueue((q) => [
      ...q,
      ...incoming.map<QueueItem>((file) => ({
        id: qId(),
        file,
        status: "queued",
        progress: 0,
        result: null,
        error: null,
      })),
    ]);

  const removeItem = (id: string) => setQueue((q) => q.filter((i) => i.id !== id));
  const clearQueue = () => setQueue((q) => q.filter((i) => i.status === "uploading"));

  function changeMode(m: string) {
    setMode(m);
    if (m === "files" || m === "folder") setQueue((q) => q.filter((i) => i.status === "uploading"));
  }

  function baseOpts(): UploadOpts {
    return {
      maxUsesRaw: options.maxUses.trim(),
      expiresInSec: options.expiresIn.trim() ? parseDuration(options.expiresIn) : null,
      randomize: options.randomize,
      encMode: options.encMode,
      compress: options.compress,
      tempDays: options.tempDays.trim(),
      archDays: options.archDays.trim(),
      delDays: options.delDays.trim(),
      folderMode: mode === "folder",
    };
  }

  // ── Success modal builders (mirror showSuccessModal / showDirectorySuccess) ──
  function popFileSuccess(data: UploadResult, encMode: string, clientKeyBytes: Uint8Array | null) {
    const shareUrl = fullShareUrl(data, encMode, clientKeyBytes);
    const noKeyUrl = data.url || shareUrl.split(/[?#]ek=/)[0];
    const keyOnly =
      encMode === "client" && clientKeyBytes
        ? b64urlEncode(clientKeyBytes)
        : encMode === "server" && data.access_key
          ? data.access_key
          : "";
    const filename = data.original_filename || "file";
    const rows = [{ label: "Full", value: shareUrl, filename, open: true }];
    if (keyOnly) {
      rows.push({ label: "No key", value: noKeyUrl, filename, open: true });
      rows.push({ label: "Key", value: keyOnly, filename: "key", open: false });
    }
    setShareSpec({
      title: "Upload complete",
      rows,
      hint:
        encMode === "client" && clientKeyBytes
          ? { tone: "warn", text: "⚠ End-to-end encrypted. The key (#ek=) is in this URL only — save it. It cannot be recovered from the server." }
          : encMode === "server"
            ? { tone: "warn", text: "🔐 Server-side encrypted. The access key (?ek=) is required to download — share the full URL." }
            : undefined,
      qr: shareUrl,
    });
  }

  function popDirSuccess(dir: DirObj, encMode: string, sharedKey: Uint8Array | null) {
    const shareUrl = directoryShareUrl(dir, encMode, sharedKey);
    setShareSpec({
      title: "Folder shared",
      subtitle: "Anyone with this link can browse the folder and download everything as a zip.",
      rows: [{ label: "Link", value: shareUrl, open: true }],
      hint:
        encMode === "client" && sharedKey
          ? { tone: "warn", text: "⚠ End-to-end encrypted. The key (#ek=) is in this URL only — save it. It cannot be recovered from the server." }
          : encMode === "server"
            ? { tone: "warn", text: "🔐 Server-encrypted. The access key (?ek=) is required — share the full URL." }
            : undefined,
      qr: shareUrl,
    });
  }

  // ── Upload orchestration ─────────────────────────────────────────────────
  async function runItem(item: QueueItem, opts: UploadOpts): Promise<boolean> {
    patchItem(item.id, { status: "uploading", progress: 0 });
    try {
      const outcome = await uploadOne(item, opts, (pct) => patchItem(item.id, { progress: pct }));
      patchItem(item.id, { status: "done", result: outcome.result });
      if (outcome.standalone) popFileSuccess(outcome.result, String(outcome.encMode), outcome.clientKeyBytes);
      return true;
    } catch (err) {
      patchItem(item.id, { status: "error", error: (err as Error)?.message || "Upload failed." });
      return false;
    }
  }

  async function startUpload() {
    if (options.expiresIn.trim() && parseDuration(options.expiresIn) === null) {
      return showToast('Invalid duration — use "7d", "24h", "30m"', "error");
    }
    const pending = queueRef.current.filter((i) => i.status === "queued");
    if (!pending.length) return;
    setUploading(true);

    if (mode === "folder") {
      await uploadAsDirectory(pending);
      setUploading(false);
      return;
    }

    setProgress({ label: `Uploading 0 / ${pending.length}…`, percent: 0 });
    let done = 0;
    let errs = 0;
    for (const item of pending) {
      const ok = await runItem(item, baseOpts());
      done += ok ? 1 : 0;
      errs += ok ? 0 : 1;
      setProgress({ label: `${done} / ${pending.length} uploaded`, percent: Math.round((((done + errs)) / pending.length) * 100) });
    }
    setProgress(null);
    setUploading(false);
    if (done) {
      showToast(`${done} file${done !== 1 ? "s" : ""} uploaded!`);
      loadFiles();
      loadUsage();
    }
    if (errs) showToast(`${errs} upload${errs !== 1 ? "s" : ""} failed.`, "error");
  }

  async function uploadAsDirectory(pending: QueueItem[]) {
    let title = "Shared folder";
    const rel = pending[0]?.file.webkitRelativePath;
    if (rel && rel.includes("/")) title = rel.split("/")[0];

    setProgress({ label: "Creating folder…", percent: 0 });
    const body: Record<string, unknown> = { title, encryption_mode: options.encMode };
    const exp = options.expiresIn.trim() ? parseDuration(options.expiresIn) : null;
    if (exp) body.expires_in_seconds = exp;

    let dir: DirObj;
    try {
      const resp = await apiFetch("/directories", { method: "POST", json: body });
      if (!resp.ok) {
        const d = await resp.json().catch(() => ({}));
        throw new Error(d.detail || "could not create folder");
      }
      dir = await resp.json();
    } catch (err) {
      setProgress(null);
      return showToast("Folder creation failed: " + (err as Error).message, "error");
    }

    const sharedKey = options.encMode === "client" ? crypto.getRandomValues(new Uint8Array(32)) : null;
    let done = 0;
    for (const item of pending) {
      const ok = await runItem(item, { ...baseOpts(), directoryId: dir.id, sharedClientKey: sharedKey });
      done += ok ? 1 : 0;
      setProgress({ label: `${done} / ${pending.length} uploaded`, percent: Math.round((done / pending.length) * 100) });
    }
    setProgress(null);
    if (done) {
      showToast(`Folder shared — ${done} file${done !== 1 ? "s" : ""}.`);
      popDirSuccess(dir, options.encMode, sharedKey);
    }
    loadFiles();
    loadUsage();
  }

  // ── Remote / receive ─────────────────────────────────────────────────────
  async function startRemote() {
    if (!remote.url.trim()) return showToast("Paste a remote URL first.", "error");
    setRemote({ busy: true, status: "Fetching from server…" });
    const body: Record<string, unknown> = { url: remote.url.trim() };
    if (remote.name.trim()) body.original_filename = remote.name.trim();
    const resp = await apiFetch("/files/remote-upload", { method: "POST", json: body });
    setRemote({ busy: false, status: "" });
    if (!resp.ok) {
      const d = await resp.json().catch(() => ({}));
      return showToast(d.detail || "Remote upload failed.", "error");
    }
    const result = await resp.json();
    popFileSuccess(result, "none", null);
    setRemote({ url: "", name: "" });
    loadFiles();
    loadUsage();
  }

  async function startReceive() {
    const expires = parseDuration(receive.expires.trim() || "1h");
    if (expires === null) return showToast('Invalid duration — use "1h", "7d", "30m"', "error");
    setReceive({ busy: true });
    const resp = await apiFetch("/dropbox-links", { method: "POST", json: { expires_in_seconds: expires } });
    setReceive({ busy: false });
    if (!resp.ok) {
      const d = await resp.json().catch(() => ({}));
      return showToast(d.detail || "Failed to create upload link.", "error");
    }
    const link = await resp.json();
    setReceive({ resultUrl: link.url });
  }

  // ── Directory actions ────────────────────────────────────────────────────
  const copy = (text: string) => {
    navigator.clipboard.writeText(text).catch(() => {});
    showToast("Copied to clipboard.");
  };

  async function addFilesToDirectory(d: DirObj) {
    let sharedClientKey: Uint8Array | null = null;
    if (d.encryption_mode === "client") {
      const answer = await dialog.prompt({
        title: "Folder key",
        message: "Paste the original folder link or #ek value.",
        placeholder: "#ek=...",
        confirmText: "Use key",
      });
      if (answer === null) return;
      try {
        sharedClientKey = b64urlDecodeBytes(extractEk(answer));
        if (sharedClientKey.length !== 32) throw new Error("bad");
      } catch {
        return showToast("Invalid folder key.", "error");
      }
    }
    const input = document.createElement("input");
    input.type = "file";
    input.multiple = true;
    input.style.display = "none";
    input.addEventListener(
      "change",
      async () => {
        const picked = Array.from(input.files || []);
        input.remove();
        if (!picked.length) return;
        const items = picked.map<QueueItem>((file) => ({
          id: qId(),
          file,
          status: "queued",
          progress: 0,
          result: null,
          error: null,
        }));
        setQueue((q) => [...q, ...items]);
        setUploading(true);
        setProgress({ label: `Adding 0 / ${items.length}…`, percent: 0 });
        let done = 0;
        for (const item of items) {
          const ok = await runItem(item, {
            maxUsesRaw: "",
            expiresInSec: null,
            randomize: false,
            encMode: d.encryption_mode,
            compress: false,
            tempDays: "",
            archDays: "",
            delDays: "",
            directoryId: d.id,
            sharedClientKey,
          });
          done += ok ? 1 : 0;
          setProgress({ label: `${done} / ${items.length} added`, percent: Math.round((done / items.length) * 100) });
        }
        setProgress(null);
        setUploading(false);
        if (done) showToast(`${done} file${done !== 1 ? "s" : ""} added.`);
        loadFiles();
        loadUsage();
      },
      { once: true },
    );
    document.body.appendChild(input);
    input.click();
    window.addEventListener(
      "focus",
      () => {
        if (input.isConnected) input.remove();
      },
      { once: true },
    );
  }

  async function deleteDirectory(d: DirObj) {
    const ok = await dialog.confirm({
      title: "Delete folder?",
      message: `"${d.title}" and all ${d.file_count} file${d.file_count !== 1 ? "s" : ""} inside will be permanently removed. This cannot be undone.`,
      confirmText: "Delete folder",
      danger: true,
    });
    if (!ok) return;
    const resp = await apiFetch(`/directories/${d.id}`, { method: "DELETE" });
    if (resp.ok) {
      showToast("Folder deleted.");
      loadFiles();
      loadUsage();
    } else showToast("Delete failed.", "error");
  }

  async function removeMember(dirId: number, fileId: number, name: string) {
    const ok = await dialog.confirm({
      title: "Remove file?",
      message: `"${name}" will be removed from this folder and its links will be deleted.`,
      confirmText: "Remove file",
      danger: true,
    });
    if (!ok) return;
    const resp = await apiFetch(`/directories/${dirId}/files/${fileId}`, { method: "DELETE" });
    if (resp.ok) {
      showToast("File removed.");
      loadFiles();
      loadUsage();
    } else showToast("Remove failed.", "error");
  }

  async function deleteFile(id: number, name: string) {
    const ok = await dialog.confirm({
      title: "Delete file?",
      message: `"${name}" and all its links will be permanently removed. This cannot be undone.`,
      confirmText: "Delete",
      danger: true,
    });
    if (!ok) return;
    const resp = await apiFetch(`/files/${id}`, { method: "DELETE" });
    if (resp.ok) {
      showToast("File deleted.");
      loadFiles();
      loadUsage();
    } else showToast("Delete failed.", "error");
  }

  async function setLinkActive(link: LinkObj, active: boolean) {
    const resp = await apiFetch(`/links/${link.id}`, { method: "PATCH", json: { active } });
    if (resp.ok) {
      showToast(active ? "Link reactivated." : "Link deactivated.");
      loadFiles();
    } else showToast("Failed to update link.", "error");
  }

  async function deleteLink(link: LinkObj) {
    const ok = await dialog.confirm({
      title: "Delete link?",
      message: "This permanently removes this share link. The file remains stored.",
      confirmText: "Delete link",
      danger: true,
    });
    if (!ok) return;
    const resp = await apiFetch(`/links/${link.id}`, { method: "DELETE" });
    if (resp.ok) {
      showToast("Link deleted.");
      loadFiles();
    } else showToast("Failed to delete link.", "error");
  }

  const actions: FilesActions = {
    deleteDirectory,
    addFilesToDirectory,
    removeMember,
    openMint: (fileId) => {
      setMintFileId(fileId);
      setMintFields({ maxUses: "", expires: "" });
    },
    deleteFile,
    setLinkActive,
    deleteLink,
    copy,
  };

  // ── Mint + folder modals ─────────────────────────────────────────────────
  async function confirmMint() {
    if (mintFileId == null) return;
    const expires = mintFields.expires.trim() ? parseDuration(mintFields.expires) : null;
    if (mintFields.expires.trim() && expires === null) {
      return showToast('Invalid duration — use "7d", "24h"', "error");
    }
    const body: Record<string, unknown> = {};
    if (mintFields.maxUses.trim()) body.max_uses = parseInt(mintFields.maxUses, 10);
    if (expires) body.expires_in_seconds = expires;
    const resp = await apiFetch(`/files/${mintFileId}/links`, { method: "POST", json: body });
    setMintFileId(null);
    if (!resp.ok) {
      const d = await resp.json().catch(() => ({}));
      return showToast(d.detail || "Failed to create link.", "error");
    }
    const data = await resp.json();
    let shareUrl = data.url;
    if (data.encryption_mode === "server" && data.access_key) {
      shareUrl += "?ek=" + encodeURIComponent(data.access_key);
      showToast("New link created & copied (key included).");
    } else if (data.encryption_mode === "client") {
      showToast("New link created — append your #ek= key before sharing.");
    } else {
      showToast("New link created & copied.");
    }
    navigator.clipboard.writeText(shareUrl).catch(() => {});
    loadFiles();
  }

  async function confirmNewFolder() {
    const title = dirFields.title.trim() || "Shared folder";
    const expires = dirFields.expires.trim() ? parseDuration(dirFields.expires) : null;
    if (dirFields.expires.trim() && expires === null) {
      return showToast('Invalid duration — use "7d", "24h", "30m"', "error");
    }
    const body: Record<string, unknown> = { title, encryption_mode: dirFields.encMode };
    if (expires) body.expires_in_seconds = expires;
    const clientKey =
      dirFields.encMode === "client" ? crypto.getRandomValues(new Uint8Array(32)) : null;
    const resp = await apiFetch("/directories", { method: "POST", json: body });
    if (!resp.ok) {
      const d = await resp.json().catch(() => ({}));
      return showToast(d.detail || "Folder creation failed.", "error");
    }
    const dir = await resp.json();
    setDirModalOpen(false);
    popDirSuccess(dir, dirFields.encMode, clientKey);
    loadFiles();
  }

  // ── Render ───────────────────────────────────────────────────────────────
  const pct = usage && usage.quota > 0 ? Math.min(100, (usage.used / usage.quota) * 100) : 0;
  const quotaTone = pct >= 90 ? "bad" : pct >= 70 ? "warn" : "accent";

  return (
    <Container>
      {usage && (
        <Card className="reveal mb-5">
          <div className="mb-2 flex items-center justify-between text-sm">
            <Eyebrow>Storage</Eyebrow>
            <span className="font-[var(--font-mono)] text-[var(--color-ink-dim)]">
              {formatBytes(usage.used)} used of {formatBytes(usage.quota)}
            </span>
          </div>
          <ProgressBar percent={pct} tone={quotaTone} />
        </Card>
      )}

      <UploadCard
        perms={perms}
        mode={mode}
        setMode={changeMode}
        queue={queue}
        addFiles={addFiles}
        removeItem={removeItem}
        clearQueue={clearQueue}
        startUpload={startUpload}
        uploading={uploading}
        progress={progress}
        options={options}
        setOptions={setOptions}
        remote={remote}
        setRemote={setRemote}
        startRemote={startRemote}
        receive={receive}
        setReceive={setReceive}
        startReceive={startReceive}
      />

      <section className="mt-8">
        <div className="mb-3 flex items-center justify-between">
          <Eyebrow>Your files &amp; folders</Eyebrow>
          <div className="flex gap-2">
            {perms.canCreateDirectories && (
              <Button
                size="sm"
                variant="ghost"
                onClick={() => {
                  setDirFields({ title: "", encMode: "none", expires: "" });
                  setDirModalOpen(true);
                }}
              >
                New folder
              </Button>
            )}
            <Button size="sm" variant="ghost" onClick={loadFiles}>
              Refresh
            </Button>
          </div>
        </div>
        <FilesList dirs={dirs} files={files} loading={listLoading} perms={perms} actions={actions} />
      </section>

      {perms.canUseApiKeys && <ApiKeysSection />}

      <ShareModal spec={shareSpec} onClose={() => setShareSpec(null)} />

      {/* Mint link modal */}
      <Modal
        open={mintFileId != null}
        onClose={() => setMintFileId(null)}
        title="Create a new link"
        footer={
          <>
            <Button variant="ghost" onClick={() => setMintFileId(null)}>
              Cancel
            </Button>
            <Button onClick={confirmMint}>Create link</Button>
          </>
        }
      >
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Max downloads">
            <Input
              autoFocus
              placeholder="unlimited"
              value={mintFields.maxUses}
              onChange={(e) => setMintFields((f) => ({ ...f, maxUses: e.target.value }))}
            />
          </Field>
          <Field label="Expires in">
            <Input
              placeholder='e.g. "7d"'
              value={mintFields.expires}
              onChange={(e) => setMintFields((f) => ({ ...f, expires: e.target.value }))}
            />
          </Field>
        </div>
      </Modal>

      {/* New folder modal */}
      <Modal
        open={dirModalOpen}
        onClose={() => setDirModalOpen(false)}
        title="New shared folder"
        footer={
          <>
            <Button variant="ghost" onClick={() => setDirModalOpen(false)}>
              Cancel
            </Button>
            <Button onClick={confirmNewFolder}>Create folder</Button>
          </>
        }
      >
        <div className="space-y-3">
          <Field label="Title">
            <Input
              autoFocus
              placeholder="Shared folder"
              value={dirFields.title}
              onChange={(e) => setDirFields((f) => ({ ...f, title: e.target.value }))}
            />
          </Field>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Encryption">
              <Select
                value={dirFields.encMode}
                onChange={(e) => setDirFields((f) => ({ ...f, encMode: e.target.value }))}
              >
                <option value="none">None</option>
                <option value="server">Server-side (?ek=)</option>
                {perms.canUploadClientEncrypted && <option value="client">End-to-end (#ek=)</option>}
              </Select>
            </Field>
            <Field label="Expires in">
              <Input
                placeholder="optional"
                value={dirFields.expires}
                onChange={(e) => setDirFields((f) => ({ ...f, expires: e.target.value }))}
              />
            </Field>
          </div>
        </div>
      </Modal>
    </Container>
  );
}
