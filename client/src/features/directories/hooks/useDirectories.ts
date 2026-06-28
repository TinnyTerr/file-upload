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

export function useDirLinks(dirId: number, enabled = true) {
  return useQuery({
    queryKey: dirKeys.links(dirId),
    queryFn: () => dirService.listLinks(dirId),
    enabled,
  });
}

export function useCreateDirLink(dirId: number) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: Parameters<typeof dirService.createLink>[1]) => dirService.createLink(dirId, body),
    onSuccess: () => {
      toast.success("Link created");
      qc.invalidateQueries({ queryKey: dirKeys.links(dirId) });
    },
    onError: (err) => toast.error("Couldn't create link", { description: errorMessage(err) }),
  });
}

export function useUpdateDirLink(dirId: number) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ linkId, ...body }: { linkId: number } & Parameters<typeof dirService.updateLink>[2]) =>
      dirService.updateLink(dirId, linkId, body),
    onSuccess: () => {
      toast.success("Link updated");
      qc.invalidateQueries({ queryKey: dirKeys.links(dirId) });
    },
    onError: (err) => toast.error("Couldn't update link", { description: errorMessage(err) }),
  });
}

export function useDeleteDirLink(dirId: number) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (linkId: number) => dirService.deleteLink(dirId, linkId),
    onSuccess: () => {
      toast.success("Link deleted");
      qc.invalidateQueries({ queryKey: dirKeys.links(dirId) });
    },
    onError: (err) => toast.error("Couldn't delete link", { description: errorMessage(err) }),
  });
}
