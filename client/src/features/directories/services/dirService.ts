import { api } from "@/config/api";
import type { EncryptionMode } from "@/features/files/types";
import type { Directory, DirectoryMember, CreateDirectoryResult } from "../types";

export const dirService = {
  list: () => api.get<{ directories: Directory[] }>("/directories/").then((r) => r.directories),

  create: (body: { title: string; encryption_mode: EncryptionMode; expires_in_seconds?: number | null }) =>
    api.post<CreateDirectoryResult>("/directories", { json: body }),

  members: (dirId: number) =>
    api.get<{ files: DirectoryMember[] }>(`/directories/${dirId}/files`).then((r) => r.files),

  removeMember: (dirId: number, fileId: number) =>
    api.delete(`/directories/${dirId}/files/${fileId}`),

  addCollaborator: (dirId: number, username: string) =>
    api.post(`/directories/${dirId}/collaborators`, { json: { username } }),

  removeCollaborator: (dirId: number, userId: number) =>
    api.delete(`/directories/${dirId}/collaborators/${userId}`),

  remove: (dirId: number) => api.delete(`/directories/${dirId}`),
};
