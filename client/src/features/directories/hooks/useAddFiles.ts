import { useCallback, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { performUpload } from "@/features/files/lib/uploadCore";
import { filesKeys } from "@/features/files/hooks/queryKeys";
import { dirKeys } from "./queryKeys";
import { errorMessage } from "@/config/api";
import type { EncryptionMode } from "@/features/files/types";

export function useAddFiles(dirId: number, mode: EncryptionMode) {
  const qc = useQueryClient();
  const [busy, setBusy] = useState(false);

  const addFiles = useCallback(
    async (files: File[], presetKey?: Uint8Array) => {
      if (!files.length) return;
      if (mode === "client" && !presetKey) return;
      setBusy(true);
      try {
        for (const file of files) {
          await performUpload({
            file,
            options: { encryption_mode: mode, directory_id: dirId },
            presetKey,
          });
        }
        toast.success(`Added ${files.length} file${files.length === 1 ? "" : "s"}`);
        qc.invalidateQueries({ queryKey: dirKeys.members(dirId) });
        qc.invalidateQueries({ queryKey: dirKeys.list });
        qc.invalidateQueries({ queryKey: filesKeys.usage });
      } catch (err) {
        toast.error("Couldn't add files", { description: errorMessage(err) });
      } finally {
        setBusy(false);
      }
    },
    [dirId, mode, qc],
  );

  return { addFiles, busy };
}
