import {
	Download,
	Film,
	Folder,
	Image as ImageIcon,
	Lock,
	Music,
	Play,
} from "lucide-react";
import { useEffect, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { ListRow } from "@/components/ui/list-row";
import { Tooltip } from "@/components/ui/tooltip";
import {
	previewPath,
	thumbnailPath,
} from "@/features/download/services/publicService";
import { iconForType } from "@/features/files/lib/fileMeta";
import { formatBytes } from "@/lib/bytes";
import type { FolderKeys } from "../hooks/useFolderKeys";
import { downloadMember } from "../hooks/useFolderView";
import type {
	PublicDirInfo,
	PublicDirMember,
	PublicDirNode,
} from "../services/publicDirService";

type Group = "videos" | "audio" | "images" | "other";

function groupOf(m: PublicDirMember): Group {
	const ct = (m.content_type ?? "").toLowerCase();
	if (ct.startsWith("video/")) return "videos";
	if (ct.startsWith("audio/")) return "audio";
	// SVG is never rendered inline anywhere in this app (XSS), so it belongs
	// with the plain files rather than the photo wall.
	if (ct.startsWith("image/") && !ct.includes("svg")) return "images";
	return "other";
}

/** The `?ek=` a member's own key scope resolves to, for the media endpoints. */
function accessKeyFor(
	m: PublicDirMember,
	keys: FolderKeys,
): string | undefined {
	return m.encryption_mode === "server"
		? keys.held(m.key_scope)?.secret
		: undefined;
}

/** Whether this member's bytes can be shown inline right now: the server has
 * to be willing to serve them *and* the visitor has to hold the key. */
function playable(m: PublicDirMember, keys: FolderKeys): boolean {
	return m.previewable && keys.isUnlocked(m);
}

/** Cover art for a tile. Plaintext members get the cheap cached JPEG; an
 * encrypted image has no thumbnail (the thumbnailer only ever sees plaintext),
 * so it falls back to the full preview. Encrypted video gets neither and
 * renders as its icon. */
function posterFor(m: PublicDirMember, keys: FolderKeys): string | null {
	if (!playable(m, keys)) return null;
	if (m.encryption_mode === "none") return thumbnailPath(m.slug);
	return groupOf(m) === "images"
		? previewPath(m.slug, accessKeyFor(m, keys))
		: null;
}

/** One poster tile — the media library's card, minus the routing. */
function Tile({
	poster,
	icon,
	overlay,
	title,
	subtitle,
	badge,
	onClick,
	disabled = false,
	ariaLabel,
}: {
	poster: string | null;
	icon: React.ReactNode;
	overlay?: React.ReactNode;
	title: string;
	subtitle: string;
	badge?: React.ReactNode;
	onClick: () => void;
	disabled?: boolean;
	ariaLabel: string;
}) {
	const [posterFailed, setPosterFailed] = useState(false);
	return (
		<button
			type="button"
			onClick={onClick}
			disabled={disabled}
			aria-label={ariaLabel}
			className="group relative flex flex-col overflow-hidden rounded-xl border border-border bg-card text-left transition-all hover:-translate-y-1 hover:border-primary/50 hover:shadow-lg hover:shadow-primary/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-60"
		>
			<div className="relative aspect-video w-full overflow-hidden bg-secondary/40">
				{poster && !posterFailed && (
					<img
						src={poster}
						alt=""
						loading="lazy"
						className="size-full object-cover transition-transform duration-300 group-hover:scale-105"
						onError={() => setPosterFailed(true)}
					/>
				)}
				<div className="pointer-events-none absolute inset-0 flex items-center justify-center">
					{(!poster || posterFailed) && icon}
				</div>
				{overlay}
				<div className="pointer-events-none absolute inset-0 bg-gradient-to-t from-black/70 via-transparent to-transparent" />
				{badge && <div className="absolute right-2 top-2">{badge}</div>}
			</div>
			<div className="space-y-0.5 p-3">
				<h3 className="line-clamp-1 text-sm font-semibold" title={title}>
					{title}
				</h3>
				<p className="text-xs text-muted-foreground">{subtitle}</p>
			</div>
		</button>
	);
}

function PlayOverlay() {
	return (
		<div className="pointer-events-none absolute inset-0 flex items-center justify-center opacity-0 transition-opacity group-hover:opacity-100">
			<div className="flex size-12 items-center justify-center rounded-full bg-background/80 backdrop-blur">
				<Play className="size-5 fill-current" />
			</div>
		</div>
	);
}

function Section({
	title,
	children,
}: {
	title: string;
	children: React.ReactNode;
}) {
	return (
		<section className="space-y-3">
			<h2 className="text-sm font-semibold text-muted-foreground">{title}</h2>
			{children}
		</section>
	);
}

/**
 * Showcase rendering of one level of a shared folder: subfolders and media as
 * poster tiles, video/audio playable in place, photos in a lightbox.
 *
 * Deliberately borrows the media library's card language (features/media) while
 * staying entirely separate from it — `is_library` is the curated global /watch
 * catalog; this is a per-folder presentation switch on a share link.
 */
export function FolderGallery({
	info,
	keys,
	onNavigate,
	onOpenMember,
}: {
	info: PublicDirInfo;
	keys: FolderKeys;
	onNavigate: (id: number) => void;
	onOpenMember: (m: PublicDirMember) => void;
}) {
	const [playing, setPlaying] = useState<PublicDirMember | null>(null);

	// Navigating within the shared tree re-renders this component rather than
	// remounting it, so the player would otherwise keep playing a member of
	// the folder the visitor just left — with a Download button acting on it.
	// biome-ignore lint/correctness/useExhaustiveDependencies: keyed on the open folder only.
	useEffect(() => {
		setPlaying(null);
	}, [info.id]);

	const videos = info.files.filter((m) => groupOf(m) === "videos");
	const audio = info.files.filter((m) => groupOf(m) === "audio");
	const images = info.files.filter((m) => groupOf(m) === "images");
	const others = info.files.filter((m) => groupOf(m) === "other");

	const subtitleFor = (sub: PublicDirNode) =>
		[
			sub.subdirectory_count > 0
				? `${sub.subdirectory_count} folder${sub.subdirectory_count === 1 ? "" : "s"}`
				: null,
			`${sub.file_count} file${sub.file_count === 1 ? "" : "s"}`,
			keys.isUnlocked(sub) ? null : "locked",
		]
			.filter(Boolean)
			.join(" · ");

	const mediaTile = (m: PublicDirMember, kind: "videos" | "audio") => {
		const canPlay = playable(m, keys);
		return (
			<Tile
				key={m.slug}
				poster={posterFor(m, keys)}
				icon={
					kind === "videos" ? (
						<Film className="size-8 text-muted-foreground/40" />
					) : (
						<Music className="size-8 text-muted-foreground/40" />
					)
				}
				overlay={canPlay ? <PlayOverlay /> : undefined}
				title={m.filename}
				subtitle={formatBytes(m.size_bytes)}
				badge={
					canPlay ? undefined : (
						<Badge
							variant="outline"
							className="gap-1 bg-background/80 backdrop-blur"
						>
							<Lock className="size-3" />
							{keys.isUnlocked(m) ? "Download only" : "Locked"}
						</Badge>
					)
				}
				// A member can be locked while its folder is open — a file that is
				// its own break point. Downloading it would navigate the tab to a
				// 401 and, for a password-locked one, spend a guess.
				onClick={() =>
					canPlay
						? setPlaying(m)
						: keys.isUnlocked(m)
							? downloadMember(m, keys)
							: undefined
				}
				disabled={!canPlay && !keys.isUnlocked(m)}
				ariaLabel={
					canPlay
						? `Play ${m.filename}`
						: keys.isUnlocked(m)
							? `Download ${m.filename}`
							: `${m.filename} — locked`
				}
			/>
		);
	};

	return (
		<div className="space-y-8">
			{playing && (
				<Card className="overflow-hidden">
					<div className="bg-black">
						{groupOf(playing) === "videos" ? (
							<video
								key={playing.slug}
								src={previewPath(playing.slug, accessKeyFor(playing, keys))}
								controls
								autoPlay
								className="aspect-video w-full"
								preload="metadata"
							>
								<track kind="captions" />
							</video>
						) : (
							<div className="flex aspect-[4/1] w-full items-center justify-center px-6">
								<audio
									key={playing.slug}
									src={previewPath(playing.slug, accessKeyFor(playing, keys))}
									controls
									autoPlay
									className="w-full"
								/>
							</div>
						)}
					</div>
					<CardContent className="flex flex-wrap items-center justify-between gap-3 p-4">
						<div className="min-w-0 space-y-1">
							<p className="truncate font-medium" title={playing.filename}>
								{playing.filename}
							</p>
							<div className="flex flex-wrap items-center gap-2">
								<span className="text-xs text-muted-foreground">
									{formatBytes(playing.size_bytes)}
								</span>
								{playing.encryption_mode !== "none" && (
									<Tooltip content="Decrypted on the fly from the start of the file, so it can't be seeked.">
										<Badge variant="outline">No seeking</Badge>
									</Tooltip>
								)}
							</div>
						</div>
						<div className="flex items-center gap-1">
							<Button
								variant="ghost"
								size="sm"
								onClick={() => downloadMember(playing, keys)}
							>
								<Download /> Download
							</Button>
							<Button
								variant="ghost"
								size="sm"
								onClick={() => setPlaying(null)}
							>
								Close
							</Button>
						</div>
					</CardContent>
				</Card>
			)}

			{info.directories.length > 0 && (
				<Section title="Folders">
					<div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4">
						{info.directories.map((sub) => (
							<Tile
								key={sub.id}
								poster={null}
								icon={
									keys.isUnlocked(sub) ? (
										<Folder className="size-8 text-muted-foreground/40" />
									) : (
										<Lock className="size-8 text-warning/60" />
									)
								}
								title={sub.title}
								subtitle={subtitleFor(sub)}
								onClick={() => onNavigate(sub.id)}
								ariaLabel={`Open ${sub.title}`}
							/>
						))}
					</div>
				</Section>
			)}

			{videos.length > 0 && (
				<Section title="Videos">
					<div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4">
						{videos.map((m) => mediaTile(m, "videos"))}
					</div>
				</Section>
			)}

			{audio.length > 0 && (
				<Section title="Audio">
					<div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4">
						{audio.map((m) => mediaTile(m, "audio"))}
					</div>
				</Section>
			)}

			{images.length > 0 && (
				<Section title="Photos">
					<div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-5">
						{images.map((m) => {
							const canView = playable(m, keys);
							return (
								<Tile
									key={m.slug}
									poster={posterFor(m, keys)}
									icon={
										<ImageIcon className="size-7 text-muted-foreground/40" />
									}
									title={m.filename}
									subtitle={formatBytes(m.size_bytes)}
									badge={
										canView ? undefined : (
											<Badge
												variant="outline"
												className="gap-1 bg-background/80 backdrop-blur"
											>
												<Lock className="size-3" />
												{keys.isUnlocked(m) ? "Download only" : "Locked"}
											</Badge>
										)
									}
									onClick={() =>
										canView
											? onOpenMember(m)
											: keys.isUnlocked(m)
												? downloadMember(m, keys)
												: undefined
									}
									disabled={!canView && !keys.isUnlocked(m)}
									ariaLabel={
										canView
											? `View ${m.filename}`
											: keys.isUnlocked(m)
												? `Download ${m.filename}`
												: `${m.filename} — locked`
									}
								/>
							);
						})}
					</div>
				</Section>
			)}

			{others.length > 0 && (
				<Section title="Files">
					<Card>
						<CardContent className="space-y-1.5 p-4">
							{others.map((m) => {
								const Icon = iconForType(m.content_type);
								const unlocked = keys.isUnlocked(m);
								return (
									<ListRow
										key={m.slug}
										leading={
											<Icon className="size-4 shrink-0 text-muted-foreground" />
										}
										trailing={
											<Button
												variant="ghost"
												size="icon"
												disabled={!unlocked}
												onClick={() => downloadMember(m, keys)}
												aria-label={`Download ${m.filename}`}
											>
												<Download />
											</Button>
										}
									>
										<span
											className="flex items-center gap-2 truncate text-sm"
											title={m.filename}
										>
											<span className="truncate">{m.filename}</span>
											<span className="shrink-0 text-xs text-muted-foreground">
												{formatBytes(m.size_bytes)}
											</span>
											{!unlocked && (
												<Lock className="size-3.5 shrink-0 text-warning" />
											)}
										</span>
									</ListRow>
								);
							})}
						</CardContent>
					</Card>
				</Section>
			)}

			{info.directories.length === 0 && info.files.length === 0 && (
				<p className="py-6 text-center text-sm text-muted-foreground">
					This folder is empty.
				</p>
			)}
		</div>
	);
}
