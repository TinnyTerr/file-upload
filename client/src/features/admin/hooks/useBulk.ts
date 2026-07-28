import { useQueryClient } from "@tanstack/react-query";
import { useCallback, useState } from "react";
import { toast } from "sonner";
import { errorMessage } from "@/config/api";
import { adminService } from "../services/adminService";
import type { BulkAction, BulkPreview } from "../types";

/**
 * Two-step preview → confirm flow for destructive bulk operations. Operates on
 * an explicit set of ids (selection-driven); an empty list targets everything.
 */
export function useBulk(onDone?: () => void) {
	const qc = useQueryClient();
	const [preview, setPreview] = useState<{
		action: BulkAction;
		ids: number[];
		data: BulkPreview;
	} | null>(null);
	const [loading, setLoading] = useState(false);
	const [running, setRunning] = useState(false);

	const startPreview = useCallback(
		async (action: BulkAction, ids: number[] = []) => {
			setLoading(true);
			try {
				const data = await adminService.bulkPreview(action, ids);
				setPreview({ action, ids, data });
			} catch (err) {
				toast.error("Couldn't preview action", {
					description: errorMessage(err),
				});
			} finally {
				setLoading(false);
			}
		},
		[],
	);

	const confirm = useCallback(async () => {
		if (!preview) return;
		setRunning(true);
		try {
			const res = await adminService.bulkRun(
				preview.action,
				preview.ids,
				preview.data.confirmation_phrase,
			);
			toast.success("Bulk action complete", {
				description: `${res.processed_count} processed`,
			});
			setPreview(null);
			qc.invalidateQueries({ queryKey: ["admin"] });
			onDone?.();
		} catch (err) {
			toast.error("Bulk action failed", { description: errorMessage(err) });
		} finally {
			setRunning(false);
		}
	}, [preview, qc, onDone]);

	return {
		preview,
		startPreview,
		confirm,
		cancel: () => setPreview(null),
		loading,
		running,
	};
}

export type UseBulk = ReturnType<typeof useBulk>;
