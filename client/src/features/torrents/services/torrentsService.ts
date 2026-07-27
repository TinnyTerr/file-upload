import { api } from "@/config/api";
import type { AddTorrentInput, TorrentConfig, TorrentJob } from "../types";

export const torrentsService = {
  config: () => api.get<TorrentConfig>("/torrents/config"),

  list: () => api.get<{ torrents: TorrentJob[]; configured: boolean }>("/torrents/"),

  add: (input: AddTorrentInput) => api.post<TorrentJob>("/torrents/", { json: input }),

  retry: (jobId: number) => api.post<TorrentJob>(`/torrents/${jobId}/retry`),

  remove: (jobId: number) => api.delete(`/torrents/${jobId}`),
};
