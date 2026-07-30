import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { errorMessage } from "@/config/api";
import { mediaService } from "../services/mediaService";
import type { MintPlayKeyInput, PublishInput } from "../types";

const LIBRARY_QUERY = ["media", "library"] as const;
const PLAYKEYS_QUERY = ["media", "playkeys"] as const;

export function collectionQueryKey(slug: string) {
	return ["media", "collection", slug] as const;
}

/** The library index. Works logged-out — the backend answers with just the
 * public collections when there's no session. */
export function useMediaLibrary() {
	return useQuery({
		queryKey: LIBRARY_QUERY,
		queryFn: mediaService.library,
		staleTime: 30_000,
	});
}

export function useMediaCollection(slug: string | undefined) {
	return useQuery({
		queryKey: collectionQueryKey(slug ?? ""),
		queryFn: () => mediaService.collection(slug!),
		enabled: !!slug,
	});
}

/** Publish / unpublish a folder as a library collection. */
export function useMediaCuration() {
	const qc = useQueryClient();
	const invalidate = () => {
		void qc.invalidateQueries({ queryKey: LIBRARY_QUERY });
		void qc.invalidateQueries({ queryKey: ["media", "collection"] });
		void qc.invalidateQueries({ queryKey: ["directories"] });
	};

	const publish = useMutation({
		mutationFn: ({
			directoryId,
			input,
		}: {
			directoryId: number;
			input: PublishInput;
		}) => mediaService.publish(directoryId, input),
		onSuccess: (c) => {
			toast.success("Published to the library", { description: c.title });
			invalidate();
		},
		onError: (err) =>
			toast.error("Couldn't publish", { description: errorMessage(err) }),
	});

	const unpublish = useMutation({
		mutationFn: (directoryId: number) => mediaService.unpublish(directoryId),
		onSuccess: () => {
			toast.success("Removed from the library");
			invalidate();
		},
		onError: (err) =>
			toast.error("Couldn't unpublish", { description: errorMessage(err) }),
	});

	return { publish, unpublish };
}

export function usePlayKeys() {
	const qc = useQueryClient();
	const invalidate = () =>
		void qc.invalidateQueries({ queryKey: PLAYKEYS_QUERY });

	const list = useQuery({
		queryKey: PLAYKEYS_QUERY,
		queryFn: mediaService.playKeys,
	});

	// The minted key comes back exactly once; the caller is responsible for
	// showing it before it's gone (see PlayKeyDialog).
	const mint = useMutation({
		mutationFn: (input: MintPlayKeyInput) => mediaService.mintPlayKey(input),
		onSuccess: invalidate,
		onError: (err) =>
			toast.error("Couldn't create a play key", {
				description: errorMessage(err),
			}),
	});

	const revoke = useMutation({
		mutationFn: (id: number) => mediaService.revokePlayKey(id),
		onSuccess: () => {
			toast.success("Play key revoked");
			invalidate();
		},
		onError: (err) =>
			toast.error("Couldn't revoke that key", {
				description: errorMessage(err),
			}),
	});

	return { list, mint, revoke };
}
