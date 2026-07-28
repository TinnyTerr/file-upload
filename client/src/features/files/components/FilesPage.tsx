import { FolderUp } from "lucide-react";
import { PageHeader } from "@/components/layout/PageHeader";
import { useAuth } from "@/features/auth/hooks/auth";
import { FoldersList } from "@/features/directories/components/FoldersList";
import { FilesList } from "./FilesList";
import { UploadPanel } from "./UploadPanel";
import { UsageMeter } from "./UsageMeter";

export function FilesPage() {
	const { can } = useAuth();
	const canUpload = can("can_upload");

	return (
		<div className="space-y-6">
			<PageHeader
				title="Files"
				subtitle="Upload, manage, and share files with links you control."
				icon={FolderUp}
			/>

			<div className="grid min-w-0 gap-6 lg:grid-cols-[minmax(0,1fr)_320px]">
				<div className="order-2 min-w-0 space-y-6 lg:order-1">
					{canUpload && <UploadPanel />}
					<FoldersList />
					<FilesList />
				</div>
				<div className="order-1 min-w-0 space-y-6 lg:order-2">
					<UsageMeter />
				</div>
			</div>
		</div>
	);
}
