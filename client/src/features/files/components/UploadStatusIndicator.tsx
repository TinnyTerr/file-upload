import { UploadCloud } from "lucide-react";
import { useNavigate } from "react-router-dom";
import { Button } from "@/components/ui/button";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuLabel,
	DropdownMenuSeparator,
	DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useUpload } from "../hooks/useUpload";
import { UploadQueue } from "./UploadQueue";

const ACTIVE_STATUSES = new Set([
	"queued",
	"encrypting",
	"uploading",
	"finalizing",
]);

/**
 * Lives in the app header (mounted once in AppShell, outside the routed
 * page tree) so it keeps showing transfer progress even after navigating
 * away from the Files tab, where the upload was started.
 */
export function UploadStatusIndicator() {
	const { items, cancel, retry, clearFinished } = useUpload();
	const navigate = useNavigate();

	if (!items.length) return null;

	const activeCount = items.filter((it) =>
		ACTIVE_STATUSES.has(it.status),
	).length;

	return (
		<DropdownMenu>
			<DropdownMenuTrigger asChild>
				<Button
					variant="ghost"
					size="icon"
					className="relative"
					aria-label="Uploads"
				>
					<UploadCloud
						className={
							activeCount > 0
								? "animate-pulse text-primary"
								: "text-muted-foreground"
						}
					/>
					{activeCount > 0 && (
						<span className="absolute right-1 top-1 flex size-4 items-center justify-center rounded-full bg-brand-gradient text-[10px] font-semibold text-white">
							{activeCount}
						</span>
					)}
				</Button>
			</DropdownMenuTrigger>
			<DropdownMenuContent align="end" className="w-80 p-3">
				<div className="flex items-center justify-between px-1 pb-2">
					<DropdownMenuLabel className="p-0 text-sm font-semibold text-foreground">
						{activeCount > 0
							? `Uploading ${activeCount} file${activeCount > 1 ? "s" : ""}`
							: "Transfers"}
					</DropdownMenuLabel>
					<Button variant="ghost" size="sm" onClick={() => navigate("/files")}>
						View
					</Button>
				</div>
				<DropdownMenuSeparator className="-mx-3" />
				<div className="mt-2 max-h-80 overflow-y-auto">
					<UploadQueue items={items} onCancel={cancel} onRetry={retry} />
				</div>
				{activeCount === 0 && (
					<>
						<DropdownMenuSeparator className="-mx-3" />
						<Button
							variant="ghost"
							size="sm"
							className="mt-1 w-full"
							onClick={clearFinished}
						>
							Clear finished
						</Button>
					</>
				)}
			</DropdownMenuContent>
		</DropdownMenu>
	);
}
