import { useCallback, useState } from "react";
import { toast } from "sonner";
import { errorMessage } from "@/config/api";
import { dirService } from "@/features/directories/services/dirService";
import { filesService } from "@/features/files/services/filesService";
import type { DriveItem } from "../lib/items";
import { itemName } from "../lib/items";
import { useInvalidateDrive } from "./useDrive";

function plural(n: number, one: string, many = `${one}s`): string {
	return `${n} ${n === 1 ? one : many}`;
}

/**
 * Move / rename / delete across both id spaces.
 *
 * Batches run sequentially and keep going after a failure: moving ten things
 * into a folder that rejects one of them (a cycle, a depth limit, someone
 * else's folder) should still move the other nine, and say which ones didn't
 * make it, rather than stopping half way with no explanation.
 */
export function useDriveMutations() {
	const invalidate = useInvalidateDrive();
	const [busy, setBusy] = useState(false);

	const runBatch = useCallback(
		async (
			items: DriveItem[],
			verb: string,
			op: (item: DriveItem) => Promise<unknown>,
		): Promise<boolean> => {
			if (!items.length) return true;
			setBusy(true);
			const failures: { name: string; reason: string }[] = [];
			try {
				for (const item of items) {
					try {
						await op(item);
					} catch (err) {
						failures.push({ name: itemName(item), reason: errorMessage(err) });
					}
				}
			} finally {
				setBusy(false);
				invalidate();
			}
			const done = items.length - failures.length;
			if (done) toast.success(`${verb} ${plural(done, "item")}`);
			if (failures.length) {
				toast.error(
					`Couldn't ${verb.toLowerCase()} ${plural(failures.length, "item")}`,
					{
						description: failures
							.slice(0, 3)
							.map((f) => `${f.name}: ${f.reason}`)
							.join("\n"),
					},
				);
			}
			return failures.length === 0;
		},
		[invalidate],
	);

	const move = useCallback(
		(items: DriveItem[], destination: number | null) =>
			runBatch(items, "Moved", (item) =>
				item.kind === "folder"
					? dirService.move(item.id, destination)
					: filesService.move(item.id, destination),
			),
		[runBatch],
	);

	const copy = useCallback(
		(items: DriveItem[], destination: number | null) =>
			runBatch(items, "Copied", (item) =>
				item.kind === "folder"
					? dirService.copy(item.id, destination)
					: filesService.copy(item.id, destination),
			),
		[runBatch],
	);

	const remove = useCallback(
		(items: DriveItem[]) =>
			runBatch(items, "Deleted", (item) =>
				item.kind === "folder"
					? dirService.remove(item.id)
					: filesService.delete(item.id),
			),
		[runBatch],
	);

	const rename = useCallback(
		async (item: DriveItem, name: string) => {
			setBusy(true);
			try {
				if (item.kind === "folder") await dirService.rename(item.id, name);
				else await filesService.rename(item.id, name);
				toast.success("Renamed");
				return true;
			} catch (err) {
				toast.error("Couldn't rename", { description: errorMessage(err) });
				return false;
			} finally {
				setBusy(false);
				invalidate();
			}
		},
		[invalidate],
	);

	return { move, copy, remove, rename, busy };
}
