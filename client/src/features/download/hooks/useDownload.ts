import { useCallback, useEffect, useRef, useState } from "react";
import { useParams } from "react-router-dom";
import { b64urlDecodeBytes } from "../../../lib/keys";
import { clientDecrypt, saveBlob } from "../../../lib/crypto";
import { useToast } from "../../../providers/ToastProvider";
import { useDialog } from "../../../providers/DialogProvider";
import { fetchCiphertext, fetchFileInfo, saveToMyFiles, type FileInfo } from "../services/downloadService";

/** Data loading + decryption/download orchestration for the public file page. */
export function useDownload() {
  const { slug = "" } = useParams();
  const { showToast } = useToast();
  const dialog = useDialog();

  const [info, setInfo] = useState<FileInfo | null>(null);
  const [status, setStatus] = useState<"loading" | "error" | "ready">("loading");
  const [btnLabel, setBtnLabel] = useState("Download");
  const [btnBusy, setBtnBusy] = useState(false);
  const [hash, setHash] = useState("");

  const fragmentKey = useRef<string | null>(null);
  const queryKey = useRef<string | null>(null);

  useEffect(() => {
    const m = window.location.hash.match(/[#&]ek=([^&]*)/);
    fragmentKey.current = m ? m[1] : null;
    queryKey.current = new URLSearchParams(window.location.search).get("ek");
  }, []);

  useEffect(() => {
    if (!slug) return setStatus("error");
    (async () => {
      try {
        const data = await fetchFileInfo(slug);
        setInfo(data);
        document.title = `${data.filename} — Oxymoron`;
        const firstHash = Object.entries(data.hashes || {}).find(([, v]) => v)?.[0] || "";
        setHash(firstHash);
        setStatus("ready");
      } catch {
        setStatus("error");
      }
    })();
  }, [slug]);

  const clientDownload = useCallback(
    async (fragKey: string, filename: string) => {
      setBtnBusy(true);
      setBtnLabel("⟳ Decrypting…");
      try {
        let keyBytes: Uint8Array;
        try {
          keyBytes = b64urlDecodeBytes(fragKey);
        } catch {
          throw new Error("the key in the URL is malformed");
        }
        if (keyBytes.length !== 32)
          throw new Error("wrong key length — check the full #ek= value was copied");
        const ciphertext = await fetchCiphertext(slug);
        const plaintext = await clientDecrypt(ciphertext, keyBytes, (pct) =>
          setBtnLabel(`⟳ Decrypting… ${pct}%`),
        );
        saveBlob(new Blob([plaintext]), filename);
      } catch (err) {
        dialog.alert({
          title: "Decryption failed",
          message: (err as Error).message,
          glyph: "🔒",
          kind: "error",
        });
      } finally {
        setBtnBusy(false);
        setBtnLabel("Download");
      }
    },
    [slug, dialog],
  );

  async function saveFile() {
    try {
      await saveToMyFiles(slug);
      showToast("Saved to your files.");
    } catch (err) {
      showToast((err as Error).message || "Save failed.", "error");
    }
  }

  return {
    slug,
    info,
    status,
    hash,
    setHash,
    btnBusy,
    btnLabel,
    frag: fragmentKey.current,
    qk: queryKey.current,
    clientDownload,
    saveFile,
    dialog,
  };
}
