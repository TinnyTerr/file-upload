import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { torrentsService } from "../services/torrentsService";
import { errorMessage } from "@/config/api";
import type { AddTorrentInput, TorrentJob } from "../types";

const LIST_QUERY = ["torrents", "list"] as const;
const CONFIG_QUERY = ["torrents", "config"] as const;

/** Poll while anything is still moving; idle lists don't need a heartbeat. */
function refetchInterval(torrents: TorrentJob[] | undefined): number | false {
  const busy = torrents?.some((t) => t.status === "queued" || t.status === "downloading" || t.status === "importing");
  return busy ? 3000 : false;
}

export function useTorrents() {
  const qc = useQueryClient();
  const invalidate = () => {
    void qc.invalidateQueries({ queryKey: LIST_QUERY });
    void qc.invalidateQueries({ queryKey: ["files"] });
    void qc.invalidateQueries({ queryKey: ["directories"] });
  };

  const config = useQuery({ queryKey: CONFIG_QUERY, queryFn: torrentsService.config, staleTime: 60_000 });

  const list = useQuery({
    queryKey: LIST_QUERY,
    queryFn: () => torrentsService.list().then((r) => r.torrents),
    refetchInterval: (query) => refetchInterval(query.state.data),
  });

  const add = useMutation({
    mutationFn: (input: AddTorrentInput) => torrentsService.add(input),
    onSuccess: (job) => {
      toast.success("Torrent added", { description: job.name });
      invalidate();
    },
    onError: (err) => toast.error("Couldn't add torrent", { description: errorMessage(err) }),
  });

  const retry = useMutation({
    mutationFn: (jobId: number) => torrentsService.retry(jobId),
    onSuccess: () => {
      toast.success("Import retried");
      invalidate();
    },
    onError: (err) => toast.error("Retry failed", { description: errorMessage(err) }),
  });

  const remove = useMutation({
    mutationFn: (jobId: number) => torrentsService.remove(jobId),
    onSuccess: () => {
      toast.success("Torrent removed");
      invalidate();
    },
    onError: (err) => toast.error("Couldn't remove torrent", { description: errorMessage(err) }),
  });

  return { config, list, add, retry, remove };
}
