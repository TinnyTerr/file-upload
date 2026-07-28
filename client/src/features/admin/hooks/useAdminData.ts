import {
	keepPreviousData,
	useMutation,
	useQuery,
	useQueryClient,
} from "@tanstack/react-query";
import { toast } from "sonner";
import { errorMessage } from "@/config/api";
import { adminService } from "../services/adminService";

export function useAdminFiles() {
	const qc = useQueryClient();
	const list = useQuery({
		queryKey: ["admin", "files"],
		queryFn: adminService.files,
	});
	const dirs = useQuery({
		queryKey: ["admin", "dirs"],
		queryFn: adminService.directories,
	});

	const invalidate = () => {
		qc.invalidateQueries({ queryKey: ["admin", "files"] });
		qc.invalidateQueries({ queryKey: ["admin", "storage"] });
	};

	const archive = useMutation({
		mutationFn: (id: number) => adminService.archiveFile(id),
		onSuccess: () => {
			toast.success("File archived");
			invalidate();
		},
		onError: (err) =>
			toast.error("Couldn't archive", { description: errorMessage(err) }),
	});
	const unarchive = useMutation({
		mutationFn: (id: number) => adminService.unarchiveFile(id),
		onSuccess: () => {
			toast.success("File unarchived");
			invalidate();
		},
		onError: (err) =>
			toast.error("Couldn't unarchive", { description: errorMessage(err) }),
	});

	return { list, dirs, archive, unarchive };
}

export function useAdminKeys() {
	return useQuery({ queryKey: ["admin", "keys"], queryFn: adminService.keys });
}

export function useAudit(params: {
	limit: number;
	offset: number;
	q?: string;
	action?: string;
	verify?: boolean;
}) {
	return useQuery({
		queryKey: ["admin", "audit", params],
		queryFn: () => adminService.audit(params),
		placeholderData: keepPreviousData,
	});
}

export function useClusterAudit(
	params: {
		limit: number;
		offset: number;
		q?: string;
		action?: string;
		server?: string;
	},
	enabled: boolean,
) {
	return useQuery({
		queryKey: ["admin", "cluster-audit", params],
		queryFn: () => adminService.clusterAudit(params),
		placeholderData: keepPreviousData,
		enabled,
	});
}

export function useBackendLogs(
	params: { limit: number; q?: string; level?: string; server?: string },
	autoRefresh: boolean,
) {
	return useQuery({
		queryKey: ["admin", "logs", params],
		queryFn: () => adminService.backendLogs(params),
		refetchInterval: autoRefresh ? 3000 : false,
		placeholderData: keepPreviousData,
	});
}
