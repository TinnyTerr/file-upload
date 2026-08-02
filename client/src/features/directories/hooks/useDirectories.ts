import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { errorMessage } from "@/config/api";
import { filesKeys } from "@/features/files/hooks/queryKeys";
import { dirService } from "../services/dirService";
import { dirKeys } from "./queryKeys";

export function useDirectories() {
	return useQuery({ queryKey: dirKeys.list, queryFn: dirService.list });
}

export function useBrowse(parentId: number | null) {
	return useQuery({
		queryKey: dirKeys.browse(parentId),
		queryFn: () => dirService.browse(parentId),
	});
}

/** Every folder-tree mutation invalidates every open browse() level, not just
 * the current one -- a rename/move/encrypt/delete can change what a
 * completely different breadcrumb level should show (e.g. moving a folder
 * changes both its old and new parent's listing). React Query's prefix
 * matching means this one call covers all of them. */
function invalidateBrowseTree(qc: ReturnType<typeof useQueryClient>) {
	qc.invalidateQueries({ queryKey: ["directories", "browse"] });
	qc.invalidateQueries({ queryKey: dirKeys.list });
}

export function useCreateDirectory() {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: (body: Parameters<typeof dirService.create>[0]) =>
			dirService.create(body),
		onSuccess: () => {
			toast.success("Folder created");
			invalidateBrowseTree(qc);
		},
		onError: (err) =>
			toast.error("Couldn't create folder", { description: errorMessage(err) }),
	});
}

export function useUpdateDirectory() {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: (vars: {
			dirId: number;
			title?: string;
			parent_directory_id?: number | null;
		}) => dirService.update(vars.dirId, vars),
		onSuccess: () => {
			invalidateBrowseTree(qc);
		},
		onError: (err) =>
			toast.error("Couldn't update folder", { description: errorMessage(err) }),
	});
}

export function useEncryptDirectory() {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: (dirId: number) => dirService.encrypt(dirId),
		onSuccess: () => {
			toast.success("Folder encrypted");
			invalidateBrowseTree(qc);
		},
		onError: (err) =>
			toast.error("Couldn't encrypt folder", { description: errorMessage(err) }),
	});
}

export function useDeleteDirectory() {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: (dirId: number) => dirService.remove(dirId),
		onSuccess: () => {
			toast.success("Folder deleted");
			invalidateBrowseTree(qc);
			qc.invalidateQueries({ queryKey: filesKeys.usage });
		},
		onError: (err) =>
			toast.error("Couldn't delete folder", { description: errorMessage(err) }),
	});
}

export function useDirLinks(dirId: number, enabled = true) {
	return useQuery({
		queryKey: dirKeys.links(dirId),
		queryFn: () => dirService.listLinks(dirId),
		enabled,
	});
}

export function useCreateDirLink(dirId: number) {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: (body: Parameters<typeof dirService.createLink>[1]) =>
			dirService.createLink(dirId, body),
		onSuccess: () => {
			toast.success("Link created");
			qc.invalidateQueries({ queryKey: dirKeys.links(dirId) });
		},
		onError: (err) =>
			toast.error("Couldn't create link", { description: errorMessage(err) }),
	});
}

export function useUpdateDirLink(dirId: number) {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: ({
			linkId,
			...body
		}: { linkId: number } & Parameters<typeof dirService.updateLink>[2]) =>
			dirService.updateLink(dirId, linkId, body),
		onSuccess: () => {
			toast.success("Link updated");
			qc.invalidateQueries({ queryKey: dirKeys.links(dirId) });
		},
		onError: (err) =>
			toast.error("Couldn't update link", { description: errorMessage(err) }),
	});
}

export function useDeleteDirLink(dirId: number) {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: (linkId: number) => dirService.deleteLink(dirId, linkId),
		onSuccess: () => {
			toast.success("Link deleted");
			qc.invalidateQueries({ queryKey: dirKeys.links(dirId) });
		},
		onError: (err) =>
			toast.error("Couldn't delete link", { description: errorMessage(err) }),
	});
}
