import { Film, Globe, Lock, Music } from "lucide-react";
import { Link } from "react-router-dom";
import { Badge } from "@/components/ui/badge";
import { posterUrl } from "../services/mediaService";
import type { MediaCollection } from "../types";

function runtime(seconds: number | null): string | null {
	if (!seconds) return null;
	const hours = Math.floor(seconds / 3600);
	const mins = Math.round((seconds % 3600) / 60);
	if (hours) return `${hours}h ${mins}m`;
	return `${mins}m`;
}

/** One tile in the library grid: cover art with the title and a visibility
 * badge, the whole thing a link into the collection. */
export function MediaPosterCard({
	collection,
}: {
	collection: MediaCollection;
}) {
	const total = runtime(collection.total_duration_seconds);
	const isPublic = collection.visibility === "public";

	return (
		<Link
			to={`/watch/${collection.slug}`}
			className="group relative flex flex-col overflow-hidden rounded-xl border border-border bg-card transition-all hover:-translate-y-1 hover:border-primary/50 hover:shadow-lg hover:shadow-primary/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
		>
			<div className="relative aspect-video w-full overflow-hidden bg-secondary/40">
				{collection.has_poster ? (
					<img
						src={posterUrl(collection.slug)}
						alt=""
						loading="lazy"
						className="size-full object-cover transition-transform duration-300 group-hover:scale-105"
						// A collection whose only entries are encrypted or archived has
						// no renderable poster; fall back to the icon underneath.
						onError={(e) => {
							e.currentTarget.style.display = "none";
						}}
					/>
				) : null}
				<div className="pointer-events-none absolute inset-0 flex items-center justify-center">
					{collection.kind === "movie" ? (
						<Film className="size-8 text-muted-foreground/40" />
					) : (
						<Music className="size-8 text-muted-foreground/40" />
					)}
				</div>
				<div className="pointer-events-none absolute inset-0 bg-gradient-to-t from-black/70 via-transparent to-transparent" />
				<Badge
					variant={isPublic ? "secondary" : "outline"}
					className="absolute right-2 top-2 gap-1 bg-background/80 backdrop-blur"
				>
					{isPublic ? (
						<Globe className="size-3" />
					) : (
						<Lock className="size-3" />
					)}
					{isPublic ? "Public" : "Restricted"}
				</Badge>
			</div>

			<div className="space-y-1 p-3">
				<h3 className="line-clamp-1 font-semibold" title={collection.title}>
					{collection.title}
				</h3>
				<p className="text-xs text-muted-foreground">
					{collection.kind === "movie"
						? "Movie"
						: `${collection.entry_count} ${collection.entry_count === 1 ? "episode" : "episodes"}`}
					{total ? ` · ${total}` : ""}
				</p>
				{collection.overview && (
					<p className="line-clamp-2 text-xs text-muted-foreground/80">
						{collection.overview}
					</p>
				)}
			</div>
		</Link>
	);
}
