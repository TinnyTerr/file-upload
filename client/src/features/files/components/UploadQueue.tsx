import { AlertCircle, CheckCircle2, Lock, RotateCw, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { Tooltip } from "@/components/ui/tooltip";
import { formatBytes } from "@/lib/bytes";
import { formatEta } from "@/lib/time";
import type { UploadItem } from "../hooks/useUpload";

const PHASE_LABEL: Record<string, string> = {
	queued: "Queued",
	encrypting: "Encrypting",
	uploading: "Uploading",
	finalizing: "Finalizing",
	done: "Done",
	error: "Failed",
	cancelled: "Cancelled",
};

function StatusIcon({ status }: { status: UploadItem["status"] }) {
	if (status === "done")
		return <CheckCircle2 className="size-4 text-success" />;
	if (status === "error")
		return <AlertCircle className="size-4 text-destructive" />;
	if (status === "encrypting") return <Lock className="size-4 text-primary" />;
	return null;
}

/** "3 of 12 · 240 MB of 1.1 GB" across the whole queue -- a batch's overall
 * progress isn't obvious from a scrolling list of individual items. */
function BatchSummary({ items }: { items: UploadItem[] }) {
	const done = items.filter((it) => it.status === "done").length;
	const totalBytes = items.reduce((sum, it) => sum + it.size, 0);
	const transferredBytes = items.reduce(
		(sum, it) =>
			sum + (it.status === "done" ? it.size : (it.size * it.percent) / 100),
		0,
	);
	return (
		<p className="px-0.5 pb-1 text-xs text-muted-foreground">
			{done} of {items.length} · {formatBytes(transferredBytes)} of{" "}
			{formatBytes(totalBytes)}
		</p>
	);
}

export function UploadQueue({
	items,
	onCancel,
	onRetry,
}: {
	items: UploadItem[];
	onCancel: (id: string) => void;
	onRetry?: (id: string) => void;
}) {
	if (!items.length) return null;

	return (
		<>
			{items.length > 1 && <BatchSummary items={items} />}
			<ul className="space-y-2">
				{items.map((item) => {
					const active =
						item.status === "encrypting" ||
						item.status === "uploading" ||
						item.status === "finalizing";
					const failed = item.status === "error" || item.status === "cancelled";
					return (
						<li
							key={item.id}
							className="rounded-lg border border-border bg-secondary/20 p-3"
						>
							<div className="flex items-center justify-between gap-2">
								<span className="flex min-w-0 items-center gap-2">
									<StatusIcon status={item.status} />
									<span
										className="truncate text-sm font-medium"
										title={item.filename}
									>
										{item.filename}
									</span>
								</span>
								<span className="flex items-center gap-2 text-xs text-muted-foreground">
									{formatBytes(item.size)}
									{active && (
										<Tooltip content="Cancel">
											<Button
												variant="ghost"
												size="icon"
												className="size-6"
												aria-label="Cancel upload"
												onClick={() => onCancel(item.id)}
											>
												<X className="size-3.5" />
											</Button>
										</Tooltip>
									)}
									{failed && onRetry && (
										<Tooltip content="Retry">
											<Button
												variant="ghost"
												size="icon"
												className="size-6"
												aria-label="Retry upload"
												onClick={() => onRetry(item.id)}
											>
												<RotateCw className="size-3.5" />
											</Button>
										</Tooltip>
									)}
								</span>
							</div>
							{active && (
								<Progress value={item.percent} className="mt-2 h-1.5" />
							)}
							<p className="mt-1 text-xs text-muted-foreground">
								{PHASE_LABEL[item.status]}
								{active && ` · ${item.percent}%`}
								{active &&
									item.speedBps != null &&
									` · ${formatBytes(item.speedBps)}/s · ETA ${formatEta(item.etaSeconds)}`}
								{item.status === "error" && item.error && ` · ${item.error}`}
							</p>
						</li>
					);
				})}
			</ul>
		</>
	);
}
