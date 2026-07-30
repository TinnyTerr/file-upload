import { api } from "@/config/api";
import type {
	MediaCollection,
	MediaLibrary,
	MintedPlayKey,
	MintPlayKeyInput,
	PlayKey,
	PublishInput,
} from "../types";

/** Stream and poster URLs are plain hrefs handed to <video>/<img>, not fetched
 * through the typed client — the browser needs a URL it can range-request with
 * the session cookie attached. */
export function streamUrl(fileId: number): string {
	return `/api/media/stream/${fileId}`;
}

export function posterUrl(slug: string): string {
	return `/api/media/library/${encodeURIComponent(slug)}/poster`;
}

export function entryThumbnailUrl(fileId: number): string {
	return `/api/media/entry/${fileId}/thumbnail`;
}

export const mediaService = {
	library: () => api.get<MediaLibrary>("/media/library"),

	collection: (slug: string) =>
		api.get<MediaCollection>(`/media/library/${encodeURIComponent(slug)}`),

	publish: (directoryId: number, input: PublishInput) =>
		api.put<MediaCollection>(`/media/library/${directoryId}`, { json: input }),

	unpublish: (directoryId: number) =>
		api.delete(`/media/library/${directoryId}`),

	playKeys: () =>
		api.get<{ keys: PlayKey[] }>("/media/playkeys").then((r) => r.keys),

	mintPlayKey: (input: MintPlayKeyInput) =>
		api.post<MintedPlayKey>("/media/playkeys", { json: input }),

	revokePlayKey: (id: number) => api.delete(`/media/playkeys/${id}`),
};
