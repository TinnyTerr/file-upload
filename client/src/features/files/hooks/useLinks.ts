import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { filesService } from "../services/filesService";
import { filesKeys } from "./queryKeys";
import { errorMessage } from "@/config/api";

export function useLinks() {
  const qc = useQueryClient();
  const invalidate = () => {
    qc.invalidateQueries({ queryKey: filesKeys.list });
    qc.invalidateQueries({ queryKey: ["admin", "files"] });
  };

  const mint = useMutation({
    mutationFn: (vars: { fileId: number; max_uses?: number | null; expires_in_seconds?: number | null }) =>
      filesService.mintLink(vars.fileId, { max_uses: vars.max_uses, expires_in_seconds: vars.expires_in_seconds }),
    onSuccess: () => {
      toast.success("Link created");
      invalidate();
    },
    onError: (err) => toast.error("Couldn't create link", { description: errorMessage(err) }),
  });

  const edit = useMutation({
    mutationFn: (vars: { linkId: number; max_uses?: number | null; expires_in_seconds?: number | null; active?: boolean }) =>
      filesService.editLink(vars.linkId, vars),
    onSuccess: () => invalidate(),
    onError: (err) => toast.error("Couldn't update link", { description: errorMessage(err) }),
  });

  const remove = useMutation({
    mutationFn: (linkId: number) => filesService.deleteLink(linkId),
    onSuccess: () => {
      toast.success("Link deleted");
      invalidate();
    },
    onError: (err) => toast.error("Couldn't delete link", { description: errorMessage(err) }),
  });

  return { mint, edit, remove };
}
