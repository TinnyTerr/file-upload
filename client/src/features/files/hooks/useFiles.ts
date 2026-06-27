import { useCallback, useEffect, useRef, useState } from "react";
import { parseDuration } from "../../../lib/api";
import {
  b64urlEncode,
  directoryShareUrl,
  extractEk,
  b64urlDecodeBytes,
  fullShareUrl,
  type UploadResult,
} from "../../../lib/keys";
import { useToast } from "../../../providers/ToastProvider";
import { useDialog } from "../../../providers/DialogProvider";
import { fetchMe } from "../../auth/services/authService";
import { fetchUsage, listFiles, deleteFile as deleteFileReq } from "../services/filesService";
import {
  createDirectory,
  deleteDirectory as deleteDirectoryReq,
  listDirectories,
  removeDirectoryFile,
} from "../services/directoriesService";
import { deleteLink as deleteLinkReq, mintLink, setLinkActive as setLinkActiveReq } from "../services/linksService";
import { createReceiveLink, remoteUpload } from "../services/transferService";
import { qId, uploadOne, type QueueItem, type UploadOpts } from "../services/uploadCore";
import type { UploadOptionsState } from "../components/UploadCard";
import type { FilesActions } from "../components/FilesList";
import type { ShareSpec } from "../components/ShareModal";
import type { DirObj, FileObj, LinkObj, Permissions } from "../types";

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

/** All state, data-fetching, and orchestration for the Files page. */
export function useFiles() {
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
    const u = await fetchUsage();
    if (u) setUsage(u);
  }, []);

  const loadFiles = useCallback(async () => {
    setListLoading(true);
    try {
      const [f, d] = await Promise.all([listFiles(), listDirectories()]);
      setFiles(f);
      setDirs(d);
    } finally {
      setListLoading(false);
    }
  }, []);

  useEffect(() => {
    (async () => {
      const me = await fetchMe();
      if (me) {
        setPerms({
          canRegenerateLinks: !!me.can_regenerate_links,
          canUseApiKeys: !!me.can_use_api_keys,
          canDeleteFiles: !!me.can_delete,
          canDeleteLinks: !!me.can_delete_links,
          canCreateDirectories: !!me.can_create_directories,
          canUploadClientEncrypted: !!me.can_upload_client_encrypted,
        });
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

  // ── Success modal builders ─────────────────────────────────────────────────
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
      setProgress({ label: `${done} / ${pending.length} uploaded`, percent: Math.round(((done + errs) / pending.length) * 100) });
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
    const exp = options.expiresIn.trim() ? parseDuration(options.expiresIn) : null;

    let dir: DirObj;
    try {
      dir = await createDirectory({ title, encryption_mode: options.encMode, expires_in_seconds: exp });
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
    try {
      const result = await remoteUpload(remote.url.trim(), remote.name.trim() || undefined);
      setRemote({ busy: false, status: "" });
      popFileSuccess(result, "none", null);
      setRemote({ url: "", name: "" });
      loadFiles();
      loadUsage();
    } catch (err) {
      setRemote({ busy: false, status: "" });
      showToast((err as Error).message || "Remote upload failed.", "error");
    }
  }

  async function startReceive() {
    const expires = parseDuration(receive.expires.trim() || "1h");
    if (expires === null) return showToast('Invalid duration — use "1h", "7d", "30m"', "error");
    setReceive({ busy: true });
    try {
      const link = await createReceiveLink(expires);
      setReceive({ busy: false, resultUrl: link.url });
    } catch (err) {
      setReceive({ busy: false });
      showToast((err as Error).message || "Failed to create upload link.", "error");
    }
  }

  // ── Directory + file + link actions ──────────────────────────────────────
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
    try {
      await deleteDirectoryReq(d.id);
      showToast("Folder deleted.");
      loadFiles();
      loadUsage();
    } catch {
      showToast("Delete failed.", "error");
    }
  }

  async function removeMember(dirId: number, fileId: number, name: string) {
    const ok = await dialog.confirm({
      title: "Remove file?",
      message: `"${name}" will be removed from this folder and its links will be deleted.`,
      confirmText: "Remove file",
      danger: true,
    });
    if (!ok) return;
    try {
      await removeDirectoryFile(dirId, fileId);
      showToast("File removed.");
      loadFiles();
      loadUsage();
    } catch {
      showToast("Remove failed.", "error");
    }
  }

  async function deleteFile(id: number, name: string) {
    const ok = await dialog.confirm({
      title: "Delete file?",
      message: `"${name}" and all its links will be permanently removed. This cannot be undone.`,
      confirmText: "Delete",
      danger: true,
    });
    if (!ok) return;
    try {
      await deleteFileReq(id);
      showToast("File deleted.");
      loadFiles();
      loadUsage();
    } catch {
      showToast("Delete failed.", "error");
    }
  }

  async function setLinkActive(link: LinkObj, active: boolean) {
    try {
      await setLinkActiveReq(link.id, active);
      showToast(active ? "Link reactivated." : "Link deactivated.");
      loadFiles();
    } catch {
      showToast("Failed to update link.", "error");
    }
  }

  async function deleteLink(link: LinkObj) {
    const ok = await dialog.confirm({
      title: "Delete link?",
      message: "This permanently removes this share link. The file remains stored.",
      confirmText: "Delete link",
      danger: true,
    });
    if (!ok) return;
    try {
      await deleteLinkReq(link.id);
      showToast("Link deleted.");
      loadFiles();
    } catch {
      showToast("Failed to delete link.", "error");
    }
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
    const fileId = mintFileId;
    setMintFileId(null);
    let data;
    try {
      data = await mintLink(fileId, {
        max_uses: mintFields.maxUses.trim() ? parseInt(mintFields.maxUses, 10) : undefined,
        expires_in_seconds: expires ?? undefined,
      });
    } catch (err) {
      return showToast((err as Error).message || "Failed to create link.", "error");
    }
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
    const clientKey = dirFields.encMode === "client" ? crypto.getRandomValues(new Uint8Array(32)) : null;
    let dir;
    try {
      dir = await createDirectory({ title, encryption_mode: dirFields.encMode, expires_in_seconds: expires });
    } catch (err) {
      return showToast((err as Error).message || "Folder creation failed.", "error");
    }
    setDirModalOpen(false);
    popDirSuccess(dir, dirFields.encMode, clientKey);
    loadFiles();
  }

  return {
    usage, perms, mode, queue, options, setOptions,
    dirs, files, listLoading, uploading, progress,
    remote, setRemote, receive, setReceive,
    shareSpec, setShareSpec,
    mintFileId, setMintFileId, mintFields, setMintFields,
    dirModalOpen, setDirModalOpen, dirFields, setDirFields,
    changeMode, addFiles, removeItem, clearQueue,
    startUpload, startRemote, startReceive,
    actions, confirmMint, confirmNewFolder,
    loadFiles,
  };
}
