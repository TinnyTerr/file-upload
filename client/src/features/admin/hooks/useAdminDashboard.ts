import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { errorMessage } from "@/config/api";
import { adminService } from "../services/adminService";
import type { LifecycleJob } from "../types";

const adminKeys = {
	disk: ["admin", "disk"] as const,
	storage: ["admin", "storage"] as const,
};

export function useDiskStats() {
	return useQuery({
		queryKey: adminKeys.disk,
		queryFn: adminService.diskStats,
	});
}

export function useStorageDetails() {
	return useQuery({
		queryKey: adminKeys.storage,
		queryFn: adminService.storage,
	});
}

export function useStorageMutations() {
	const qc = useQueryClient();
	const invalidate = () => {
		qc.invalidateQueries({ queryKey: adminKeys.storage });
		qc.invalidateQueries({ queryKey: adminKeys.disk });
	};

	const setCap = useMutation({
		mutationFn: (bytes: number) => adminService.setStorageCap(bytes),
		onSuccess: () => {
			toast.success("Storage cap updated");
			invalidate();
		},
		onError: (err) =>
			toast.error("Couldn't update cap", { description: errorMessage(err) }),
	});

	const runJob = useMutation({
		mutationFn: (job: LifecycleJob) => adminService.runLifecycle(job),
		onSuccess: (res, job) => {
			toast.success(`Job complete: ${job}`, {
				description: `${res.processed} processed`,
			});
			invalidate();
		},
		onError: (err) =>
			toast.error("Job failed", { description: errorMessage(err) }),
	});

	return { setCap, runJob };
}

export function useRestartWorkers() {
	return useMutation({
		mutationFn: () => adminService.restartWorkers(),
		onSuccess: (res) =>
			toast.success("Workers restarted", {
				description: `${res.jobs.length} jobs rescheduled`,
			}),
		onError: (err) =>
			toast.error("Couldn't restart workers", {
				description: errorMessage(err),
			}),
	});
}
