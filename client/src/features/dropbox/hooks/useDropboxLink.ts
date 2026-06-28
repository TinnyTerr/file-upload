import { useMutation } from "@tanstack/react-query";
import { toast } from "sonner";
import { dropboxService } from "../services/dropboxService";
import { errorMessage } from "@/config/api";

export function useDropboxLink() {
  return useMutation({
    mutationFn: (vars: { expires_in_seconds: number; target_directory_id?: number | null }) =>
      dropboxService.create(vars),
    onSuccess: () => toast.success("Receive link created"),
    onError: (err) => toast.error("Couldn't create receive link", { description: errorMessage(err) }),
  });
}
