import { Download, Eye, Folder, Lock } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { ListRow } from "@/components/ui/list-row";
import { isPreviewableType } from "@/features/download/components/FilePreview";
import { iconForType } from "@/features/files/lib/fileMeta";
import { formatBytes } from "@/lib/bytes";
import type { FolderKeys } from "../hooks/useFolderKeys";
import { downloadMember } from "../hooks/useFolderView";
import type {
	PublicDirInfo,
	PublicDirMember,
} from "../services/publicDirService";

/** The plain rendering of one level of a shared folder: a subfolder list and a
 * file list. The default; `FolderGallery` is the opt-in showcase alternative. */
export function FolderListing({
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
	return (
		<>
			{info.directories.length > 0 && (
				<Card>
					<CardContent className="space-y-2 p-5">
						<h2 className="text-sm font-semibold">Folders</h2>
						<div className="grid gap-2 sm:grid-cols-2">
							{info.directories.map((sub) => {
								const subUnlocked = keys.isUnlocked(sub);
								return (
									<button
										key={sub.id}
										type="button"
										onClick={() => onNavigate(sub.id)}
										className="flex min-w-0 items-start gap-3 rounded-lg border border-border bg-secondary/20 p-3 text-left transition-colors hover:border-primary/40 hover:bg-secondary/40"
									>
										<div className="flex size-9 shrink-0 items-center justify-center rounded-md bg-background/50">
											{subUnlocked ? (
												<Folder className="size-4 text-muted-foreground" />
											) : (
												<Lock className="size-4 text-warning" />
											)}
										</div>
										<div className="min-w-0 flex-1">
											<span
												className="block truncate text-sm font-medium"
												title={sub.title}
											>
												{sub.title}
											</span>
											<span className="mt-0.5 block truncate text-xs text-muted-foreground">
												{sub.subdirectory_count > 0 &&
													`${sub.subdirectory_count} folder${sub.subdirectory_count === 1 ? "" : "s"} · `}
												{sub.file_count} file
												{sub.file_count === 1 ? "" : "s"}
												{subUnlocked ? "" : " · locked"}
											</span>
										</div>
									</button>
								);
							})}
						</div>
					</CardContent>
				</Card>
			)}

			<Card>
				<CardContent className="space-y-2 p-5">
					<h2 className="text-sm font-semibold">Files</h2>
					{info.files.length === 0 ? (
						<p className="py-2 text-sm text-muted-foreground">
							{info.directories.length > 0
								? "No files directly in this folder."
								: "This folder is empty."}
						</p>
					) : (
						<div className="space-y-1.5">
							{info.files.map((m) => {
								const Icon = iconForType(m.content_type);
								const memberUnlocked = keys.isUnlocked(m);
								// `previewable` is the server's answer about the stored
								// bytes; the key is this visitor's half of it.
								const canView =
									m.previewable &&
									memberUnlocked &&
									isPreviewableType(m.content_type);
								return (
									<ListRow
										key={m.slug}
										leading={
											<Icon className="size-4 shrink-0 text-muted-foreground" />
										}
										trailing={
											<div className="flex items-center gap-1">
												{canView && (
													<Button
														variant="ghost"
														size="icon"
														onClick={() => onOpenMember(m)}
														aria-label={`Preview ${m.filename}`}
													>
														<Eye />
													</Button>
												)}
												<Button
													variant="ghost"
													size="icon"
													disabled={!memberUnlocked}
													onClick={() => downloadMember(m, keys)}
													aria-label={`Download ${m.filename}`}
												>
													<Download />
												</Button>
											</div>
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
											{!memberUnlocked && (
												<Lock className="size-3.5 shrink-0 text-warning" />
											)}
										</span>
									</ListRow>
								);
							})}
						</div>
					)}
				</CardContent>
			</Card>
		</>
	);
}
