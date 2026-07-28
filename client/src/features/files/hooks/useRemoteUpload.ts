import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { errorMessage } from "@/config/api";
import { filesService } from "../services/filesService";
import { filesKeys } from "./queryKeys";

export function useRemoteUpload() {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: (vars: { url: string; filename?: string }) =>
			filesService.remoteUpload(vars.url, vars.filename),
		onSuccess: () => {
			toast.success("Remote file fetched");
			qc.invalidateQueries({ queryKey: filesKeys.list });
			qc.invalidateQueries({ queryKey: filesKeys.usage });
		},
		onError: (err) =>
			toast.error("Remote upload failed", { description: errorMessage(err) }),
	});
}
