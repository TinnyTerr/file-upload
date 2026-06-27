import { useEffect, useState } from "react";
import { useToast } from "../../../providers/ToastProvider";
import { useDialog } from "../../../providers/DialogProvider";
import { createKey, listKeys, resetKeyIp, revokeKey } from "../services/apiKeysService";
import type { ApiKeyObj } from "../types";

/** State + orchestration for the personal API-keys panel. */
export function useApiKeys() {
  const { showToast } = useToast();
  const dialog = useDialog();
  const [keys, setKeys] = useState<ApiKeyObj[] | null>(null);
  const [newKey, setNewKey] = useState<string | null>(null);
  const [resetId, setResetId] = useState<number | null>(null);
  const [pw, setPw] = useState("");

  async function load() {
    try {
      const all = await listKeys();
      setKeys(all.filter((k) => k.active));
    } catch {
      showToast("Failed to load API keys.", "error");
    }
  }
  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function create() {
    try {
      setNewKey(await createKey());
    } catch (err) {
      showToast((err as Error).message || "Failed to create key.", "error");
    }
  }

  async function revoke(id: number) {
    const ok = await dialog.confirm({
      title: "Revoke API key?",
      message: "Any integration using this key will immediately stop working. This cannot be undone.",
      confirmText: "Revoke key",
      danger: true,
    });
    if (!ok) return;
    try {
      await revokeKey(id);
      showToast("Key revoked.");
      load();
    } catch {
      showToast("Failed to revoke key.", "error");
    }
  }

  async function confirmReset() {
    if (!pw || resetId == null) return;
    const id = resetId;
    setResetId(null);
    setPw("");
    try {
      await resetKeyIp(id, pw);
      showToast("IP binding cleared.");
      load();
    } catch (err) {
      showToast((err as Error).message || "Failed to reset IP.", "error");
    }
  }

  function closeNewKey() {
    setNewKey(null);
    load();
  }
  function closeReset() {
    setResetId(null);
    setPw("");
  }

  return {
    keys, newKey, resetId, pw, setPw,
    create, revoke, confirmReset,
    openReset: setResetId, closeNewKey, closeReset,
    copyKey: () =>
      navigator.clipboard.writeText(newKey || "").then(() => showToast("Copied!")).catch(() => {}),
  };
}
