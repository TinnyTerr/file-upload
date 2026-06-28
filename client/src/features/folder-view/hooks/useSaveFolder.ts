import { useMutation } from "@tanstack/react-query";
import { toast } from "sonner";
import { api, errorMessage } from "@/config/api";

export function useSaveFolder() {
  return useMutation({
    mutationFn: (slug: string) => api.post<{ id: number; slug: string }>(`/d/${slug}/save`),
    onSuccess: () => toast.success("Folder saved to your files"),
    onError: (err) => toast.error("Couldn't save folder", { description: errorMessage(err) }),
  });
}
