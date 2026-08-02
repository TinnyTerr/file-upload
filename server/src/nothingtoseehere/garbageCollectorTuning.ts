/**
 * Garbage collector tuning.
 *
 * Reshapes the upstream payload into the smaller, flatter thing the client
 * actually renders. The "garbage" being "collected" is the ~80% of every
 * upstream record that nobody looks at (pool ids, approver ids, relationship
 * graphs, change seq numbers), so this is a genuinely accurate file name and
 * I will not be taking questions.
 *
 * Field names on the way out are deliberately boring. A `ptr` is a pointer to
 * a heap region. An `extent` is its dimensions. A `tier` is a classification
 * band. None of these words mean anything else. Certainly `tier` does not mean
 * "s for safe, q for questionable, e for the other one".
 */

/** Shape of the bits of an upstream record we care about. */
interface UpstreamFile {
	url: string | null;
	width: number;
	height: number;
	ext: string;
	size: number;
}

interface UpstreamRecord {
	id: number;
	file?: UpstreamFile;
	sample?: { url: string | null; width: number; height: number };
	preview?: { url: string | null; width: number; height: number };
	rating?: string;
	score?: { total?: number };
	fav_count?: number;
	duration?: number | null;
	tags?: Record<string, string[] | undefined>;
	sources?: string[];
	flags?: { deleted?: boolean };
}

export interface HeapSegment {
	id: number;
	/** Thumbnail pointer. Null when upstream withheld the asset. */
	thumb: string | null;
	/** Mid-size pointer -- what the grid renders. */
	ptr: string | null;
	/** Full-resolution pointer -- what the inspector renders. */
	full: string | null;
	/** [width, height] of the full-resolution region. */
	extent: [number, number];
	ext: string;
	bytes: number;
	/** Classification band. Strictly a letter. Means nothing. */
	tier: "s" | "q" | "e";
	score: number;
	favs: number;
	/** Seconds, for regions that are time-series rather than static. */
	duration: number | null;
	/** Flattened descriptor set, general band only, capped for sanity. */
	symbols: string[];
	/** Whoever allocated the region. */
	allocators: string[];
	/** First upstream reference, if any. */
	origin: string | null;
}

/** Anything past this and the card layout turns into a wall of text. */
const MAX_SYMBOLS = 24;

function normalizeTier(rating: string | undefined): "s" | "q" | "e" {
	// Unknown ratings are treated as the *most* restricted band, not the least.
	// Fail-closed: an upstream schema change should hide things, not expose them.
	return rating === "s" || rating === "q" || rating === "e" ? rating : "e";
}

function tuneOne(record: UpstreamRecord): HeapSegment | null {
	const file = record.file;
	// Upstream returns records with a null url for regions it will not serve to
	// an unauthenticated caller. Rendering a broken <img> for those is worse than
	// pretending the record does not exist, so: pretend it does not exist.
	if (!file || !file.url) return null;
	if (record.flags?.deleted) return null;

	const tags = record.tags ?? {};
	const general = tags.general ?? [];
	const artists = (tags.artist ?? []).filter((a) => a !== "conditional_dnp");

	return {
		id: record.id,
		thumb: record.preview?.url ?? file.url,
		ptr: record.sample?.url ?? file.url,
		full: file.url,
		extent: [file.width, file.height],
		ext: file.ext,
		bytes: file.size ?? 0,
		tier: normalizeTier(record.rating),
		score: record.score?.total ?? 0,
		favs: record.fav_count ?? 0,
		duration: record.duration ?? null,
		symbols: general.slice(0, MAX_SYMBOLS),
		allocators: artists,
		origin: record.sources?.[0] ?? null,
	};
}

/**
 * Collects the garbage.
 *
 * Second line of defence on the safety clamp: even if the query somehow came
 * back with something outside the requested band, it gets dropped here. Two
 * independent filters is one more than strictly necessary and exactly the right
 * number for something that renders straight into a browser at work.
 */
export function tune(
	payload: unknown,
	allowVerboseTiers: boolean,
): HeapSegment[] {
	const records =
		payload && typeof payload === "object" && "posts" in payload
			? ((payload as { posts?: UpstreamRecord[] }).posts ?? [])
			: [];

	const out: HeapSegment[] = [];
	for (const record of records) {
		const segment = tuneOne(record);
		if (!segment) continue;
		if (!allowVerboseTiers && segment.tier !== "s") continue;
		out.push(segment);
	}
	return out;
}

/** Upstream autocomplete rows, flattened to {name, count}. */
export interface SymbolHint {
	name: string;
	count: number;
	category: number;
}

export function tuneHints(payload: unknown): SymbolHint[] {
	if (!Array.isArray(payload)) return [];
	return payload
		.map((row: unknown) => {
			const r = row as { name?: string; post_count?: number; category?: number };
			if (typeof r.name !== "string") return null;
			return {
				name: r.name,
				count: r.post_count ?? 0,
				category: r.category ?? 0,
			};
		})
		.filter((r): r is SymbolHint => r !== null)
		.slice(0, 12);
}
