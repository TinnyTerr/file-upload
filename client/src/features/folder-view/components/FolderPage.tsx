import {
	ArrowLeft,
	Download,
	FolderArchive,
	FolderX,
	Save,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { useParams } from "react-router-dom";
import { usePublicShellWidth } from "@/components/layout/PublicShell";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { Progress } from "@/components/ui/progress";
import { Skeleton } from "@/components/ui/skeleton";
import { UserAvatar } from "@/components/ui/user-avatar";
import { useAuth } from "@/features/auth/hooks/auth";
import { EncryptionBanner } from "@/features/download/components/EncryptionBanner";
import { formatBytes } from "@/lib/bytes";
import { readClientKeyFromHash, readServerKeyFromQuery } from "@/lib/download";
import { useFolderKeys } from "../hooks/useFolderKeys";
import { useDirInfo, useFolderZip } from "../hooks/useFolderView";
import { useSaveFolder } from "../hooks/useSaveFolder";
import type { PublicDirMember } from "../services/publicDirService";
import { FolderBreadcrumbs } from "./FolderBreadcrumbs";
import { FolderFilePreviewModal } from "./FolderFilePreviewModal";
import { FolderGallery } from "./FolderGallery";
import { FolderListing } from "./FolderListing";
import { FolderUnlockPrompt } from "./FolderUnlockPrompt";

export function FolderPage() {
	const { slug = "" } = useParams();
	// Which folder in the shared tree is open. Null is the link's own folder.
	const [dir, setDir] = useState<number | null>(null);
	const { data: info, isLoading, isError } = useDirInfo(slug, dir);
	const { user } = useAuth();
	const saveFolder = useSaveFolder();
	const keys = useFolderKeys();
	const [previewMember, setPreviewMember] = useState<PublicDirMember | null>(
		null,
	);

	const clientKey = useMemo(() => readClientKeyFromHash(), []);
	const serverKey = useMemo(() => readServerKeyFromQuery(), []);
	const { downloadAll, status, progress } = useFolderZip(slug, keys);

	// Seed from the URL once the entry folder's shape is known: the link that
	// got the visitor here carries the entry folder's key, and nothing else's.
	const seeded = useRef(false);
	useEffect(() => {
		if (seeded.current || !info) return;
		seeded.current = true;
		const value =
			info.encryption_mode === "client" || info.encryption_mode === "sealed"
				? clientKey
				: info.encryption_mode === "server"
					? serverKey
					: null;
		if (!value) return;
		keys
			.unlock({
				slug,
				dirId: null,
				keyScope: info.key_scope,
				mode: info.encryption_mode,
				keyCheckBlob: info.key_check_blob,
				value,
			})
			// A wrong key in the URL just means the prompt is shown instead.
			.catch(() => {});
	}, [info, clientKey, serverKey, keys, slug]);

	// A poster grid needs the room; the plain list stays where it was.
	usePublicShellWidth(info?.gallery_view ? "wide" : "narrow");

	const goTo = (next: number | null) => setDir(next);
	/** Up one level. Derived from the breadcrumb rather than a visit history,
	 * so "back" always means the containing folder, however the visitor got
	 * here — including out of a folder they never managed to unlock. */
	const goUp = (trail: { id: number }[]) => {
		const parent = trail.length >= 2 ? trail[trail.length - 2].id : null;
		setDir(parent === info?.entry_id ? null : parent);
	};

	if (isLoading) {
		return (
			<Card>
				<CardContent className="space-y-4 p-6">
					<Skeleton className="h-8 w-1/2" />
					<Skeleton className="h-10 w-full" />
					<Skeleton className="h-40 w-full" />
				</CardContent>
			</Card>
		);
	}
	if (isError || !info) {
		return (
			<EmptyState
				icon={FolderX}
				title="Folder not found"
				description="This folder may have expired or never existed."
			/>
		);
	}

	const unlocked = keys.isUnlocked(info);
	const atEntry = dir === null || dir === info.entry_id;
	const zipping = status === "working";

	// A folder whose key the visitor doesn't hold shows the prompt instead of
	// its contents — with a way back out, so it's a wrong turn, not a dead end.
	if (!unlocked) {
		return (
			<div className="space-y-4">
				<FolderBreadcrumbs trail={info.breadcrumbs} onNavigate={goTo} />
				<FolderUnlockPrompt
					title={info.title}
					mode={info.encryption_mode}
					passwordLocked={info.password_locked}
					onBack={atEntry ? null : () => goUp(info.breadcrumbs)}
					onUnlock={(value) =>
						keys.unlock({
							slug,
							dirId: dir,
							keyScope: info.key_scope,
							mode: info.encryption_mode,
							keyCheckBlob: info.key_check_blob,
							value,
						})
					}
				/>
			</div>
		);
	}

	return (
		<div className="space-y-4">
			<FolderBreadcrumbs trail={info.breadcrumbs} onNavigate={goTo} />

			<Card>
				<CardContent className="space-y-5 p-6">
					<div className="flex items-start gap-4">
						<div className="flex size-14 shrink-0 items-center justify-center rounded-xl bg-secondary/50">
							<FolderArchive className="size-7 text-muted-foreground" />
						</div>
						<div className="min-w-0 flex-1">
							<h1 className="break-words text-xl font-bold">{info.title}</h1>
							<p className="mt-1 text-sm text-muted-foreground">
								{info.directories.length > 0 &&
									`${info.directories.length} folder${info.directories.length === 1 ? "" : "s"} · `}
								{info.file_count} files · {formatBytes(info.total_bytes)}
							</p>
						</div>
						{!atEntry && (
							<Button
								variant="ghost"
								size="sm"
								onClick={() => goUp(info.breadcrumbs)}
							>
								<ArrowLeft /> Back
							</Button>
						)}
					</div>

					<EncryptionBanner mode={info.encryption_mode} hasKey={unlocked} />

					{info.uploader && (
						<div className="flex items-center gap-2 text-sm text-muted-foreground">
							<UserAvatar
								userId={info.uploader.user_id}
								username={info.uploader.username}
								hasAvatar={info.uploader.has_avatar}
								size="sm"
							/>
							<span>
								Shared by <strong>{info.uploader.username}</strong>
							</span>
						</div>
					)}

					<div className="space-y-2">
						<Button
							size="lg"
							className="w-full"
							disabled={zipping || info.file_count === 0}
							loading={zipping}
							onClick={() =>
								downloadAll({
									dir,
									title: info.title,
									keyScope: info.key_scope,
									mode: info.encryption_mode,
									members: info.files,
								})
							}
						>
							<Download /> {zipping ? "Preparing…" : "Download all (.zip)"}
						</Button>
						{zipping && (
							<Progress
								value={
									progress.total
										? Math.round((progress.done / progress.total) * 100)
										: 0
								}
							/>
						)}
						{user && atEntry && (
							<Button
								variant="secondary"
								className="w-full"
								loading={saveFolder.isPending}
								disabled={info.already_saved}
								onClick={() =>
									saveFolder.mutate({
										slug,
										accessKey: keys.held(info.key_scope)?.secret,
									})
								}
							>
								<Save />{" "}
								{info.already_saved
									? "Already saved"
									: "Save folder to my files"}
							</Button>
						)}
					</div>
				</CardContent>
			</Card>

			{info.gallery_view ? (
				<FolderGallery
					info={info}
					keys={keys}
					onNavigate={goTo}
					onOpenMember={setPreviewMember}
				/>
			) : (
				<FolderListing
					info={info}
					keys={keys}
					onNavigate={goTo}
					onOpenMember={setPreviewMember}
				/>
			)}

			<FolderFilePreviewModal
				member={previewMember}
				accessKey={
					previewMember && previewMember.encryption_mode === "server"
						? (keys.held(previewMember.key_scope)?.secret ?? null)
						: null
				}
				open={previewMember !== null}
				onOpenChange={(open) => !open && setPreviewMember(null)}
			/>
		</div>
	);
}
