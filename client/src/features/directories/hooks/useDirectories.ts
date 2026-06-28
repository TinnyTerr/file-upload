import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { dirService } from "../services/dirService";
import { dirKeys } from "./queryKeys";
import { filesKeys } from "@/features/files/hooks/queryKeys";
import { errorMessage } from "@/config/api";

export function useDirectories() {
  return useQuery({ queryKey: dirKeys.list, queryFn: dirService.list });
}

export function useCreateDirectory() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: Parameters<typeof dirService.create>[0]) => dirService.create(body),
    onSuccess: () => {
      toast.success("Folder created");
      qc.invalidateQueries({ queryKey: dirKeys.list });
    },
    onError: (err) => toast.error("Couldn't create folder", { description: errorMessage(err) }),
  });
}

export function useDirMembers(dirId: number, enabled: boolean) {
  return useQuery({
    queryKey: dirKeys.members(dirId),
    queryFn: () => dirService.members(dirId),
    enabled,
  });
}

export function useDeleteDirectory() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (dirId: number) => dirService.remove(dirId),
    onSuccess: () => {
      toast.success("Folder deleted");
      qc.invalidateQueries({ queryKey: dirKeys.list });
      qc.invalidateQueries({ queryKey: filesKeys.usage });
    },
    onError: (err) => toast.error("Couldn't delete folder", { description: errorMessage(err) }),
  });
}

export function useRemoveMember(dirId: number) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (fileId: number) => dirService.removeMember(dirId, fileId),
    onSuccess: () => {
      toast.success("Removed from folder");
      qc.invalidateQueries({ queryKey: dirKeys.members(dirId) });
      qc.invalidateQueries({ queryKey: dirKeys.list });
    },
    onError: (err) => toast.error("Couldn't remove file", { description: errorMessage(err) }),
  });
}
