import type { EncryptionMode } from "@/features/files/types";

export interface Directory {
  id: number;
  owner_id: number;
  slug: string;
  title: string;
  url: string;
  encryption_mode: EncryptionMode;
  access_key: string | null;
  file_count: number;
  total_bytes: number;
  expires_at: string | null;
  created_at: string;
  role: "owner" | "editor" | null;
}

export interface DirectoryMember {
  id: number;
  slug: string | null;
  filename: string;
  size_bytes: number;
  content_type: string | null;
  encryption_mode: EncryptionMode;
  created_at: string;
}

export interface CreateDirectoryResult {
  id: number;
  slug: string;
  url: string;
  encryption_mode: EncryptionMode;
  access_key: string | null;
}
