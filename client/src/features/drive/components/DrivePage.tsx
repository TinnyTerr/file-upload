import { FolderOpen, HardDrive, Inbox } from "lucide-react";
import { useNavigate, useParams } from "react-router-dom";
import { PageHeader } from "@/components/layout/PageHeader";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { Skeleton } from "@/components/ui/skeleton";
import { useAuth } from "@/features/auth/hooks/auth";
import { CreateFolderDialog } from "@/features/directories/components/CreateFolderDialog";
import { UsageMeter } from "@/features/files/components/UsageMeter";
import { useDriveChildren } from "../hooks/useDrive";
import { drivePath, parseLocation } from "../types";
import { CurrentFolderBar } from "./CurrentFolderBar";
import { DriveBreadcrumbs } from "./DriveBreadcrumbs";
import { DriveListing } from "./DriveListing";
import { DriveSidePanel } from "./DriveSidePanel";
import { DriveUploadCard } from "./DriveUploadCard";

function ListingSkeleton() {
	return (
		<div className="space-y-2">
			{["a", "b", "c", "d"].map((k) => (
				<div
					key={k}
					className="flex items-center gap-3 rounded-lg border border-border bg-secondary/20 p-3"
				>
					<Skeleton className="size-9 rounded-md" />
					<div className="flex-1 space-y-1.5">
						<Skeleton className="h-4 w-1/3" />
						<Skeleton className="h-3 w-24" />
					</div>
					<Skeleton className="h-8 w-16" />
				</div>
			))}
		</div>
	);
}

/**
 * One explorer for folders and files. The open folder lives in the URL
 * (`/files/:dirId`), so navigating deeper is a normal route change with real
 * back-button behaviour, and each level is fetched on its own — never a
 * recursive dump of the whole tree.
 */
export function DrivePage() {
	const { dirId } = useParams();
	const navigate = useNavigate();
	const loc = parseLocation(dirId);
	const { data, isLoading, isError, error } = useDriveChildren(loc);
	const { can } = useAuth();

	const canUpload = can("can_upload");
	const canCreate = can("can_create_directories");
	const current = data?.directory ?? null;
	const folders = data?.directories ?? [];
	const files = data?.files ?? [];
	const isEmpty = !isLoading && folders.length === 0 && files.length === 0;

	return (
		<div className="space-y-6">
			<PageHeader
				title="Drive"
				subtitle="Browse, upload and share everything you've stored, folder by folder."
				icon={HardDrive}
			/>

			<div className="grid min-w-0 gap-6 lg:grid-cols-[minmax(0,1fr)_320px]">
				<div className="order-2 min-w-0 space-y-4 lg:order-1">
					<div className="flex flex-wrap items-center justify-between gap-2">
						<DriveBreadcrumbs trail={data?.breadcrumbs ?? []} />
						<div className="flex items-center gap-1.5">
							{current && <CurrentFolderBar dir={current} />}
							{canCreate && (
								<CreateFolderDialog
									parent={current}
									onCreated={(d) => navigate(drivePath(d.id))}
								/>
							)}
						</div>
					</div>

					{canUpload && <DriveUploadCard dir={current} />}

					<Card>
						<CardHeader>
							<CardTitle className="flex items-center gap-2">
								{current ? current.title : "My Drive"}
								{!isLoading && (
									<span className="text-sm font-normal text-muted-foreground">
										{folders.length
											? `${folders.length} folder${folders.length === 1 ? "" : "s"}`
											: ""}
										{folders.length && files.length ? " · " : ""}
										{files.length
											? `${files.length} file${files.length === 1 ? "" : "s"}`
											: ""}
									</span>
								)}
							</CardTitle>
						</CardHeader>
						<CardContent className="space-y-4">
							{isLoading ? (
								<ListingSkeleton />
							) : isError ? (
								<EmptyState
									icon={FolderOpen}
									title="Couldn't open this folder"
									description={
										(error as Error)?.message ??
										"It may have been deleted, or you may not have access."
									}
								/>
							) : isEmpty ? (
								<EmptyState
									icon={Inbox}
									title={current ? "This folder is empty" : "Nothing here yet"}
									description={
										canUpload
											? "Upload files above, or create a folder to organise them."
											: "Nothing has been shared with you here."
									}
								/>
							) : (
								data && <DriveListing data={data} />
							)}
						</CardContent>
					</Card>
				</div>

				<div className="order-1 min-w-0 space-y-6 lg:order-2">
					<UsageMeter />
					{canUpload && <DriveSidePanel />}
				</div>
			</div>
		</div>
	);
}
