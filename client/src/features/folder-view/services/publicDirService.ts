import { api } from "@/config/api";
import type { EncryptionMode } from "@/features/files/types";

export interface PublicDirMember {
  slug: string;
  filename: string;
  size_bytes: number;
  content_type: string | null;
}

export interface PublicDirInfo {
  title: string;
  encryption_mode: EncryptionMode;
  file_count: number;
  total_bytes: number;
  files: PublicDirMember[];
}

export const publicDirService = {
  info: (slug: string) => api.get<PublicDirInfo>(`/d/${slug}/info`),
};

export const dirZipPath = (slug: string, accessKey?: string | null) =>
  accessKey ? `/d/${slug}/zip?ek=${encodeURIComponent(accessKey)}` : `/d/${slug}/zip`;
