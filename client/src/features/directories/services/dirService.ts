import { api } from "@/config/api";
import type { EncryptionMode } from "@/features/files/types";
import type { Directory, DirectoryLink, DirectoryMember, CreateDirectoryResult } from "../types";

export const dirService = {
  list: () => api.get<{ directories: Directory[] }>("/directories/").then((r) => r.directories),

  create: (body: { title: string; encryption_mode: EncryptionMode; expires_in_seconds?: number | null; key_check_blob?: string | null }) =>
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

  // Directory links
  listLinks: (dirId: number) =>
    api.get<{ links: DirectoryLink[] }>(`/directories/${dirId}/links`).then((r) => r.links),

  createLink: (dirId: number, body: { max_uses?: number | null; expires_in_seconds?: number | null; hide_uploader?: boolean }) =>
    api.post<DirectoryLink>(`/directories/${dirId}/links`, { json: body }),

  updateLink: (dirId: number, linkId: number, body: { max_uses?: number | null; active?: boolean; hide_uploader?: boolean }) =>
    api.patch<DirectoryLink>(`/directories/${dirId}/links/${linkId}`, { json: body }),

  deleteLink: (dirId: number, linkId: number) =>
    api.delete(`/directories/${dirId}/links/${linkId}`),
};
