import { useQuery } from "@tanstack/react-query";
import { publicService } from "../services/publicService";

export function useFileInfo(slug: string | undefined) {
	return useQuery({
		queryKey: ["public", "file", slug],
		queryFn: () => publicService.fileInfo(slug!),
		enabled: !!slug,
		retry: false,
	});
}
