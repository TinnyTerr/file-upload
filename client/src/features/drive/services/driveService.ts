import { api } from "@/config/api";
import type { DriveChildren, DriveLocation } from "../types";

export const driveService = {
	children: (loc: DriveLocation) =>
		api.get<DriveChildren>(`/directories/${loc}/children`),
};
