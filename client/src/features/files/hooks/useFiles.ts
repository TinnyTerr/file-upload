import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { errorMessage } from "@/config/api";
import { dirKeys } from "@/features/directories/hooks/queryKeys";
import { driveKeys } from "@/features/drive/hooks/queryKeys";
import { filesService } from "../services/filesService";
import { filesKeys } from "./queryKeys";

export function useFiles() {
	return useQuery({ queryKey: filesKeys.list, queryFn: filesService.list });
}

export function useDeleteFile() {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: (fileId: number) => filesService.delete(fileId),
		onSuccess: () => {
			toast.success("File deleted");
			qc.invalidateQueries({ queryKey: filesKeys.list });
			qc.invalidateQueries({ queryKey: filesKeys.usage });
			qc.invalidateQueries({ queryKey: driveKeys.all });
			qc.invalidateQueries({ queryKey: dirKeys.list });
			qc.invalidateQueries({ queryKey: ["admin", "files"] });
			qc.invalidateQueries({ queryKey: ["admin", "storage"] });
		},
		onError: (err) =>
			toast.error("Couldn't delete file", { description: errorMessage(err) }),
	});
}

export function useSaveToMyFiles() {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: (slug: string) => filesService.saveToMyFiles(slug),
		onSuccess: () => {
			toast.success("Saved to your files");
			qc.invalidateQueries({ queryKey: filesKeys.list });
			qc.invalidateQueries({ queryKey: filesKeys.usage });
		},
		onError: (err) =>
			toast.error("Couldn't save file", { description: errorMessage(err) }),
	});
}
