import { LayoutGrid, List, Rows3, Table2 } from "lucide-react";
import { Tooltip } from "@/components/ui/tooltip";
import { useUsage } from "@/features/files/hooks/useUsage";
import { formatBytes } from "@/lib/bytes";
import { cn } from "@/lib/cn";
import { useExplorer } from "../../hooks/useExplorer";
import type { ViewMode } from "../../hooks/useExplorerPrefs";

const VIEWS: {
	id: ViewMode;
	icon: typeof List;
	label: string;
	keys: string;
}[] = [
	{ id: "icons", icon: LayoutGrid, label: "Large icons", keys: "Ctrl+Shift+1" },
	{ id: "tiles", icon: Rows3, label: "Tiles", keys: "Ctrl+Shift+2" },
	{ id: "list", icon: List, label: "List", keys: "Ctrl+Shift+3" },
	{ id: "details", icon: Table2, label: "Details", keys: "Ctrl+Shift+4" },
];

function itemBytes(items: ReturnType<typeof useExplorer>["items"]): number {
	return items.reduce(
		(n, i) => n + (i.kind === "folder" ? i.dir.total_bytes : i.file.size_bytes),
		0,
	);
}

/** Counts, selection size and quota — the bar Explorer keeps at the bottom. */
export function StatusBar() {
	const { items, totalCount, selection, prefs, updatePrefs, search } =
		useExplorer();
	const { data: usage } = useUsage();

	const folders = items.filter((i) => i.kind === "folder").length;
	const files = items.length - folders;
	const selected = selection.selectedItems;

	return (
		<div className="flex items-center gap-3 border-t border-border px-3 py-1.5 text-xs text-muted-foreground">
			<span className="shrink-0">
				{search ? `${items.length} of ${totalCount} items` : null}
				{!search &&
					`${items.length} item${items.length === 1 ? "" : "s"}${
						folders && files
							? ` · ${folders} folder${folders === 1 ? "" : "s"}, ${files} file${files === 1 ? "" : "s"}`
							: ""
					}`}
			</span>

			{selected.length > 0 && (
				<>
					<span className="text-border">|</span>
					<span className="shrink-0 text-foreground">
						{selected.length} selected
						{itemBytes(selected) > 0 &&
							` · ${formatBytes(itemBytes(selected))}`}
					</span>
				</>
			)}

			<span className="flex-1" />

			{usage && (
				<span className="shrink-0">
					{formatBytes(usage.used_bytes)} of {formatBytes(usage.quota_bytes)}{" "}
					used
				</span>
			)}

			<div className="flex shrink-0 items-center gap-0.5 border-l border-border pl-2">
				{VIEWS.map((v) => (
					<Tooltip key={v.id} content={`${v.label} (${v.keys})`}>
						<button
							type="button"
							onClick={() => updatePrefs({ view: v.id })}
							aria-pressed={prefs.view === v.id}
							aria-label={v.label}
							className={cn(
								"rounded p-1 transition-colors hover:bg-secondary hover:text-foreground",
								prefs.view === v.id && "bg-secondary text-foreground",
							)}
						>
							<v.icon className="size-3.5" />
						</button>
					</Tooltip>
				))}
			</div>
		</div>
	);
}
