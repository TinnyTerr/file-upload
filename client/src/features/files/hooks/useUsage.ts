import { useQuery } from "@tanstack/react-query";
import { filesService } from "../services/filesService";
import { filesKeys } from "./queryKeys";

export function useUsage(enabled = true) {
	return useQuery({
		queryKey: filesKeys.usage,
		queryFn: filesService.usage,
		enabled,
	});
}
