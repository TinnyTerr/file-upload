import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback } from "react";
import { dirKeys } from "@/features/directories/hooks/queryKeys";
import { filesKeys } from "@/features/files/hooks/queryKeys";
import { driveService } from "../services/driveService";
import type { DriveLocation } from "../types";
import { driveKeys } from "./queryKeys";

/** `enabled: false` is what makes the folder tree actually lazy — the picker
 * renders a `Node` per folder and would otherwise fetch every collapsed one's
 * children on mount. */
export function useDriveChildren(loc: DriveLocation, enabled = true) {
	return useQuery({
		queryKey: driveKeys.children(loc),
		queryFn: () => driveService.children(loc),
		enabled,
	});
}

/** Anything that changes the shape of the tree can land in a level the user
 * isn't looking at (a move has two ends, a delete recurses), so refresh every
 * cached level rather than trying to guess which ones went stale. */
export function useInvalidateDrive() {
	const qc = useQueryClient();
	return useCallback(() => {
		qc.invalidateQueries({ queryKey: driveKeys.all });
		qc.invalidateQueries({ queryKey: dirKeys.list });
		qc.invalidateQueries({ queryKey: filesKeys.list });
		qc.invalidateQueries({ queryKey: filesKeys.usage });
		// The admin panel lists every file and every folder in the system, so a
		// drive change staled it too. `useDeleteFile` already does this; the
		// drive's own move/rename/delete path did not.
		qc.invalidateQueries({ queryKey: ["admin"] });
	}, [qc]);
}
