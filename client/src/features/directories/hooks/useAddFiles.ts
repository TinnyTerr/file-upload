import { useCallback, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { performUpload } from "@/features/files/lib/uploadCore";
import { filesKeys } from "@/features/files/hooks/queryKeys";
import { dirKeys } from "./queryKeys";
import { errorMessage } from "@/config/api";
import type { EncryptionMode } from "@/features/files/types";

/**
 * Append files to an existing folder. Only supported for `none`-mode folders:
 * server/client folders need their original wrapping key, which the browser
 * doesn't retain after upload.
 */
export function useAddFiles(dirId: number, mode: EncryptionMode) {
  const qc = useQueryClient();
  const [busy, setBusy] = useState(false);

  const addFiles = useCallback(
    async (files: File[]) => {
      if (!files.length || mode !== "none") return;
      setBusy(true);
      try {
        for (const file of files) {
          await performUpload({ file, options: { encryption_mode: "none", directory_id: dirId } });
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
