import {
	ArrowLeft,
	Clapperboard,
	Globe,
	KeyRound,
	ListVideo,
	Lock,
	Play,
	ShieldAlert,
} from "lucide-react";
import { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
	Card,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
} from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { Skeleton } from "@/components/ui/skeleton";
import { Tooltip } from "@/components/ui/tooltip";
import { formatBytes } from "@/lib/bytes";
import { useMediaCollection } from "../hooks/useMedia";
import { streamUrl } from "../services/mediaService";
import type { MediaEntry } from "../types";
import { PlayKeyDialog, type PlayKeyTarget } from "./PlayKeyDialog";

function formatDuration(seconds: number | null): string | null {
	if (!seconds) return null;
	const h = Math.floor(seconds / 3600);
	const m = Math.floor((seconds % 3600) / 60);
	const s = Math.floor(seconds % 60);
	return h
		? `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`
		: `${m}:${String(s).padStart(2, "0")}`;
}

/** A published collection: the in-browser player plus per-title mpv keys. */
export function CollectionPage() {
	const { slug } = useParams<{ slug: string }>();
	const { data, isLoading, error } = useMediaCollection(slug);
	const [playing, setPlaying] = useState<MediaEntry | null>(null);
	const [keyTarget, setKeyTarget] = useState<PlayKeyTarget | null>(null);

	const entries = data?.entries ?? [];

	// Auto-select the first playable title so a movie starts without a click on
	// a one-item list. Client-encrypted entries can't be played here.
	useEffect(() => {
		if (!playing && entries.length > 0) {
			setPlaying(entries.find((e) => !e.client_encrypted) ?? null);
		}
	}, [entries, playing]);

	if (isLoading) {
		return (
			<div className="space-y-4">
				<Skeleton className="aspect-video w-full rounded-xl" />
				<Skeleton className="h-8 w-64" />
			</div>
		);
	}

	if (error || !data) {
		return (
			<EmptyState
				icon={ShieldAlert}
				title="Not available"
				description="This collection doesn't exist, or your account isn't entitled to it."
				action={
					<Button asChild variant="outline">
						<Link to="/watch">Back to the library</Link>
					</Button>
				}
			/>
		);
	}

	const isPublic = data.visibility === "public";

	return (
		<div className="space-y-6">
			<div className="flex items-center gap-2">
				<Button asChild variant="ghost" size="sm">
					<Link to="/watch">
						<ArrowLeft className="size-4" />
						Library
					</Link>
				</Button>
			</div>

			<div className="overflow-hidden rounded-xl border border-border bg-black">
				{playing ? (
					<video
						key={playing.file_id}
						// The session cookie rides along same-origin, so the browser needs
						// no play key of its own.
						src={streamUrl(playing.file_id)}
						controls
						autoPlay={false}
						className="aspect-video w-full"
						preload="metadata"
					>
						<track kind="captions" />
					</video>
				) : (
					<div className="flex aspect-video w-full items-center justify-center">
						<Clapperboard className="size-10 text-muted-foreground/40" />
					</div>
				)}
			</div>

			<div className="flex flex-wrap items-start justify-between gap-3">
				<div className="space-y-1">
					<div className="flex flex-wrap items-center gap-2">
						<h1 className="text-2xl font-bold tracking-tight">{data.title}</h1>
						<Badge
							variant={isPublic ? "secondary" : "outline"}
							className="gap-1"
						>
							{isPublic ? (
								<Globe className="size-3" />
							) : (
								<Lock className="size-3" />
							)}
							{isPublic ? "Public" : "Account restricted"}
						</Badge>
					</div>
					{data.overview && (
						<p className="max-w-2xl text-sm text-muted-foreground">
							{data.overview}
						</p>
					)}
					{data.uploader && (
						<p className="text-xs text-muted-foreground">
							Published by {data.uploader.username}
						</p>
					)}
				</div>
				<Button
					variant="outline"
					onClick={() =>
						setKeyTarget({
							directoryId: data.directory_id,
							title: data.title,
						})
					}
				>
					<ListVideo className="size-4" />
					Play whole collection in mpv
				</Button>
			</div>

			<Card>
				<CardHeader>
					<CardTitle>{data.kind === "movie" ? "Title" : "Episodes"}</CardTitle>
					<CardDescription>
						Play here in the browser, or mint a key to play in mpv, VLC or
						anything else that takes a URL.
					</CardDescription>
				</CardHeader>
				<CardContent className="p-0">
					<ul className="divide-y divide-border">
						{entries.map((entry) => {
							const active = playing?.file_id === entry.file_id;
							return (
								<li
									key={entry.file_id}
									className={`flex flex-wrap items-center justify-between gap-3 px-6 py-3 ${
										active ? "bg-secondary/40" : ""
									}`}
								>
									<div className="min-w-0 space-y-1">
										<div className="flex items-center gap-2">
											<span className="truncate font-medium">
												{entry.title}
											</span>
											{entry.client_encrypted && (
												<Badge variant="outline">End-to-end encrypted</Badge>
											)}
											{!entry.seekable && !entry.client_encrypted && (
												<Tooltip content="Stored compressed or encrypted at rest, so it plays from the start and can't be seeked.">
													<Badge variant="outline">No seeking</Badge>
												</Tooltip>
											)}
										</div>
										<p className="text-xs text-muted-foreground">
											{[
												formatDuration(entry.duration_seconds),
												entry.height ? `${entry.height}p` : null,
												formatBytes(entry.size_bytes),
											]
												.filter(Boolean)
												.join(" · ")}
										</p>
									</div>
									<div className="flex items-center gap-1">
										<Button
											variant={active ? "secondary" : "ghost"}
											size="sm"
											disabled={entry.client_encrypted}
											onClick={() => setPlaying(entry)}
										>
											<Play className="size-4" />
											{active ? "Playing" : "Play"}
										</Button>
										<Button
											variant="ghost"
											size="sm"
											disabled={entry.client_encrypted}
											onClick={() =>
												setKeyTarget({
													fileId: entry.file_id,
													title: entry.title,
												})
											}
										>
											<KeyRound className="size-4" />
											mpv
										</Button>
									</div>
								</li>
							);
						})}
					</ul>
				</CardContent>
			</Card>

			<PlayKeyDialog
				target={keyTarget}
				open={keyTarget !== null}
				onOpenChange={(open) => {
					if (!open) setKeyTarget(null);
				}}
			/>
		</div>
	);
}
