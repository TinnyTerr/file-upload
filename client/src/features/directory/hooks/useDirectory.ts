import { useCallback, useEffect, useRef, useState } from "react";
import { useParams } from "react-router-dom";
import { b64urlDecodeBytes } from "../../../lib/keys";
import { clientDecrypt, saveBlob } from "../../../lib/crypto";
import { buildZip } from "../../../lib/zip";
import { useToast } from "../../../providers/ToastProvider";
import { useDialog } from "../../../providers/DialogProvider";
import {
  fetchDirInfo,
  fetchMemberCiphertext,
  fetchPreviewManifest,
  saveFolder as saveFolderReq,
  type DirFile,
  type DirInfo,
  type PreviewData,
} from "../services/directoryService";

/** Data loading + per-file / bundle download orchestration for shared folders. */
export function useDirectory() {
  const { slug = "" } = useParams();
  const { showToast } = useToast();
  const dialog = useDialog();

  const [data, setData] = useState<DirInfo | null>(null);
  const [preview, setPreview] = useState<PreviewData>(null);
  const [status, setStatus] = useState<"loading" | "error" | "ready">("loading");
  const [previewsEnabled, setPreviewsEnabled] = useState(true);
  const [dlNote, setDlNote] = useState("");
  const [dlAllBusy, setDlAllBusy] = useState(false);
  const [busyFile, setBusyFile] = useState<string>("");

  const fragKey = useRef<string | null>(null);
  const queryKey = useRef<string | null>(null);
  const enc = data?.encryption_mode || "none";

  useEffect(() => {
    const m = window.location.hash.match(/[#&]ek=([^&]*)/);
    fragKey.current = m ? m[1] : null;
    queryKey.current = new URLSearchParams(window.location.search).get("ek");
  }, []);

  useEffect(() => {
    if (!slug) return setStatus("error");
    (async () => {
      try {
        const info = await fetchDirInfo(slug);
        setData(info);
        document.title = `${info.title} — Oxymoron`;
        setPreview(await fetchPreviewManifest(slug));
        setStatus("ready");
      } catch {
        setStatus("error");
      }
    })();
  }, [slug]);

  const ensureKey = useCallback(async (): Promise<boolean> => {
    if (enc === "client" && !fragKey.current) {
      const k = await dialog.prompt({
        title: "End-to-end encrypted",
        message: "Paste the folder key — the part after #ek= in the share link.",
        placeholder: "decryption key",
        glyph: "🔒",
        confirmText: "Unlock",
      });
      if (k && k.trim()) fragKey.current = k.trim();
    } else if (enc === "server" && !queryKey.current) {
      const k = await dialog.prompt({
        title: "Encrypted folder",
        message: "Paste the access key — the part after ?ek= in the share link.",
        placeholder: "access key",
        glyph: "🔐",
        confirmText: "Unlock",
      });
      if (k && k.trim()) queryKey.current = k.trim();
    }
    return enc === "client" ? !!fragKey.current : enc === "server" ? !!queryKey.current : true;
  }, [enc, dialog]);

  async function downloadOne(f: DirFile) {
    if (!(await ensureKey())) return;
    if (enc === "client") {
      setBusyFile(f.slug);
      try {
        const ct = await fetchMemberCiphertext(f.slug);
        const keyBytes = b64urlDecodeBytes(fragKey.current!);
        if (keyBytes.length !== 32) throw new Error("wrong key length — check the full #ek= value");
        const pt = await clientDecrypt(ct, keyBytes);
        saveBlob(new Blob([pt]), f.filename);
      } catch (err) {
        dialog.alert({ title: "Couldn't open file", message: (err as Error).message, glyph: "🔒", kind: "error" });
      } finally {
        setBusyFile("");
      }
    } else if (enc === "server") {
      window.location.href = `/file/${f.slug}/raw?ek=${encodeURIComponent(queryKey.current!)}`;
    } else {
      window.location.href = `/file/${f.slug}/raw`;
    }
  }

  async function downloadAll() {
    if (!data || !(await ensureKey())) return;
    if (enc !== "client") {
      const ek = enc === "server" ? `?ek=${encodeURIComponent(queryKey.current!)}` : "";
      window.location.href = `/d/${slug}/zip${ek}`;
      return;
    }
    setDlAllBusy(true);
    setDlNote("");
    let keyBytes: Uint8Array;
    try {
      keyBytes = b64urlDecodeBytes(fragKey.current!);
      if (keyBytes.length !== 32) throw new Error("wrong key length");
    } catch (err) {
      setDlAllBusy(false);
      return dialog.alert({ title: "Bad key", message: (err as Error).message, glyph: "🔒", kind: "error" });
    }
    const entries: { name: string; data: Uint8Array }[] = [];
    try {
      for (let i = 0; i < data.files.length; i++) {
        const f = data.files[i];
        setDlNote(`Decrypting ${i + 1} / ${data.files.length} — ${f.filename}`);
        const ct = await fetchMemberCiphertext(f.slug);
        const pt = await clientDecrypt(ct, keyBytes);
        entries.push({ name: f.filename, data: new Uint8Array(pt) });
      }
      setDlNote("Packaging .zip…");
      saveBlob(buildZip(entries), `${data.title || "bundle"}.zip`);
      setDlNote(`✓ Downloaded ${entries.length} files.`);
      showToast("Bundle ready.");
    } catch (err) {
      setDlNote("");
      dialog.alert({ title: "Bundle failed", message: (err as Error).message, glyph: "🔒", kind: "error" });
    } finally {
      setDlAllBusy(false);
    }
  }

  async function saveFolder() {
    try {
      await saveFolderReq(slug);
      showToast("Folder saved to your files.");
    } catch (err) {
      showToast((err as Error).message || "Folder save failed.", "error");
    }
  }

  const haveKey = enc === "client" ? !!fragKey.current : enc === "server" ? !!queryKey.current : true;

  return {
    data, preview, status, enc, haveKey,
    previewsEnabled, setPreviewsEnabled,
    dlNote, dlAllBusy, busyFile,
    downloadOne, downloadAll, saveFolder,
  };
}
