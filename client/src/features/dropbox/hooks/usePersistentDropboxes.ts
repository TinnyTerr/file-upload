import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { errorMessage } from "@/config/api";
import { dropboxService } from "../services/dropboxService";

const LIST_KEY = ["dropbox", "persistent"] as const;

export function usePersistentDropboxes() {
	const qc = useQueryClient();
	const invalidate = () => qc.invalidateQueries({ queryKey: LIST_KEY });
	const fail = (what: string) => (err: unknown) =>
		toast.error(`Couldn't ${what}`, { description: errorMessage(err) });

	const list = useQuery({
		queryKey: LIST_KEY,
		queryFn: dropboxService.list,
		// Counts tick up while the page is open.
		refetchInterval: 15_000,
	});

	const create = useMutation({
		mutationFn: dropboxService.create,
		onSuccess: () => {
			toast.success("Dropbox created");
			invalidate();
		},
		onError: fail("create dropbox"),
	});

	const update = useMutation({
		mutationFn: (v: {
			id: number;
			body: Parameters<typeof dropboxService.update>[1];
		}) => dropboxService.update(v.id, v.body),
		onSuccess: invalidate,
		onError: fail("update dropbox"),
	});

	const remove = useMutation({
		mutationFn: dropboxService.remove,
		onSuccess: () => {
			toast.success("Dropbox deleted");
			invalidate();
		},
		onError: fail("delete dropbox"),
	});

	return { list, create, update, remove };
}

export function useDropboxReceived(id: number, enabled: boolean) {
	return useQuery({
		queryKey: ["dropbox", "received", id],
		queryFn: () => dropboxService.received(id),
		enabled,
		refetchInterval: enabled ? 10_000 : false,
	});
}
