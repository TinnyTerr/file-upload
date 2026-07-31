import { useMutation } from "@tanstack/react-query";
import { toast } from "sonner";
import { api, errorMessage } from "@/config/api";

/** `?ek=` is required for a server-encrypted folder, exactly as it is for the
 * zip — the save reads the members' bytes, so it is gated the same way. */
export function useSaveFolder() {
	return useMutation({
		mutationFn: ({
			slug,
			accessKey,
		}: {
			slug: string;
			accessKey?: string | null;
		}) =>
			api.post<{ id: number; slug: string }>(`/d/${slug}/save`, {
				query: accessKey ? { ek: accessKey } : undefined,
			}),
		onSuccess: () => toast.success("Folder saved to your files"),
		onError: (err) =>
			toast.error("Couldn't save folder", { description: errorMessage(err) }),
	});
}
