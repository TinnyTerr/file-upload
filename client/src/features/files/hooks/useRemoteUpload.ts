import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { errorMessage } from "@/config/api";
import { driveKeys } from "@/features/drive/hooks/queryKeys";
import { filesService } from "../services/filesService";
import { filesKeys } from "./queryKeys";

export function useRemoteUpload() {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: (vars: {
			url: string;
			filename?: string;
			directoryId?: number | null;
		}) => filesService.remoteUpload(vars.url, vars.filename, vars.directoryId),
		onSuccess: () => {
			toast.success("Remote file fetched");
			qc.invalidateQueries({ queryKey: filesKeys.list });
			qc.invalidateQueries({ queryKey: filesKeys.usage });
			// It may have landed in a folder the explorer is showing.
			qc.invalidateQueries({ queryKey: driveKeys.all });
		},
		onError: (err) =>
			toast.error("Remote upload failed", { description: errorMessage(err) }),
	});
}
