import { useCallback, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { performUpload, type UploadPhase, type UploadOutcome } from "../lib/uploadCore";
import { filesKeys } from "./queryKeys";
import type { UploadOptions } from "../types";

export interface UploadItem {
  id: string;
  filename: string;
  size: number;
  status: "queued" | UploadPhase | "done" | "error" | "cancelled";
  percent: number;
  error?: string;
  outcome?: UploadOutcome;
}

let seq = 0;

export function useUpload() {
  const qc = useQueryClient();
  const [items, setItems] = useState<UploadItem[]>([]);
  const [busy, setBusy] = useState(false);
  const controllers = useRef(new Map<string, AbortController>());

  const update = useCallback((id: string, patch: Partial<UploadItem>) => {
    setItems((prev) => prev.map((it) => (it.id === id ? { ...it, ...patch } : it)));
  }, []);

  const start = useCallback(
    async (files: File[], options: UploadOptions): Promise<{ filename: string; outcome: UploadOutcome }[]> => {
      if (!files.length) return [];
      const succeeded: { filename: string; outcome: UploadOutcome }[] = [];
      const queued: UploadItem[] = files.map((f) => ({
        id: `u${++seq}`,
        filename: f.name,
        size: f.size,
        status: "queued",
        percent: 0,
      }));
      setItems((prev) => [...prev, ...queued]);
      setBusy(true);

      // Sequential uploads keep memory + bandwidth predictable.
      for (let i = 0; i < files.length; i++) {
        const item = queued[i];
        const controller = new AbortController();
        controllers.current.set(item.id, controller);
        try {
          const outcome = await performUpload({
            file: files[i],
            options,
            signal: controller.signal,
            onProgress: ({ phase, percent }) => update(item.id, { status: phase, percent }),
          });
          update(item.id, { status: "done", percent: 100, outcome });
          succeeded.push({ filename: item.filename, outcome });
        } catch (err) {
          if (err instanceof DOMException && err.name === "AbortError") {
            update(item.id, { status: "cancelled" });
          } else {
            const msg = err instanceof Error ? err.message : "Upload failed";
            update(item.id, { status: "error", error: msg });
            toast.error(`Upload failed: ${item.filename}`, { description: msg });
          }
        } finally {
          controllers.current.delete(item.id);
        }
      }

      setBusy(false);
      qc.invalidateQueries({ queryKey: filesKeys.list });
      qc.invalidateQueries({ queryKey: filesKeys.usage });
      return succeeded;
    },
    [qc, update],
  );

  const cancel = useCallback((id: string) => {
    controllers.current.get(id)?.abort();
  }, []);

  const clearFinished = useCallback(() => {
    setItems((prev) => prev.filter((it) => !["done", "error", "cancelled"].includes(it.status)));
  }, []);

  const reset = useCallback(() => {
    controllers.current.forEach((c) => c.abort());
    controllers.current.clear();
    setItems([]);
  }, []);

  const completed = items.filter((it) => it.status === "done" && it.outcome);

  return { items, completed, busy, start, cancel, clearFinished, reset };
}
