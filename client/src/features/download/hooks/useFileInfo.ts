import { useQuery } from "@tanstack/react-query";
import { present } from "@/lib/present";
import { publicService } from "../services/publicService";

export function useFileInfo(slug: string | undefined) {
	return useQuery({
		queryKey: ["public", "file", slug],
		queryFn: () => publicService.fileInfo(present(slug)),
		enabled: !!slug,
		retry: false,
	});
}
