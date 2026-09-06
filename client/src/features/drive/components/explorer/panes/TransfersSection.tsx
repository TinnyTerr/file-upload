import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { UploadQueue } from "@/features/files/components/UploadQueue";
import { useUpload } from "@/features/files/hooks/useUpload";
import type { TreeProgress } from "../../../hooks/useDriveUpload";
import { Section } from "./DetailRow";

/** In-flight uploads. Mirrors the header's status indicator, which survives
 * navigation; this one is here so you can watch progress without leaving the
 * folder the files are landing in. */
export function TransfersSection({
	treeProgress,
}: {
	treeProgress: TreeProgress | null;
}) {
	const { items, busy, cancel, retry, clearFinished } = useUpload();

	if (!items.length && !treeProgress) return null;

	return (
		<Section title="Transfers">
			{treeProgress && (
				<div className="space-y-1.5">
					<Progress
						value={Math.round(
							((treeProgress.completed + treeProgress.percent / 100) /
								treeProgress.total) *
								100,
						)}
					/>
					<p className="text-xs text-muted-foreground">
						Folder: {treeProgress.completed + 1} of {treeProgress.total}
						{treeProgress.current ? ` · ${treeProgress.current}` : ""}
					</p>
				</div>
			)}
			{items.length > 0 && (
				<>
					<UploadQueue items={items} onCancel={cancel} onRetry={retry} />
					{!busy && (
						<Button
							variant="ghost"
							size="sm"
							className="w-full"
							onClick={clearFinished}
						>
							Clear finished
						</Button>
					)}
				</>
			)}
		</Section>
	);
}
