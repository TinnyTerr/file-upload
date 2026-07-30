import { KeyRound, Trash2 } from "lucide-react";
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
import { formatDateTime, relativeTime } from "@/lib/time";
import { useDialogs } from "@/providers/DialogProvider";
import { usePlayKeys } from "../hooks/useMedia";

/** Lists the caller's live play keys. The tokens themselves aren't shown —
 * only what they cover, when they die, and a revoke button. */
export function PlayKeyManager() {
	const { list, revoke } = usePlayKeys();
	const { confirm } = useDialogs();

	const onRevoke = async (id: number, label: string) => {
		const ok = await confirm({
			title: "Revoke this play key?",
			description: `Any player still using ${label} stops immediately. This can't be undone — mint a new key instead.`,
			confirmText: "Revoke",
			destructive: true,
		});
		if (ok) revoke.mutate(id);
	};

	const keys = list.data ?? [];

	return (
		<Card>
			<CardHeader>
				<CardTitle>Play keys</CardTitle>
				<CardDescription>
					URL credentials for external players. Each one expires on its own, and
					stops working the moment your library access is removed.
				</CardDescription>
			</CardHeader>
			<CardContent className="p-0">
				{keys.length === 0 ? (
					<EmptyState
						icon={KeyRound}
						title="No active play keys"
						description="Open a title and choose “Play in mpv” to create one."
					/>
				) : (
					<ul className="divide-y divide-border">
						{keys.map((k) => {
							const name =
								k.label ??
								(k.scope === "collection"
									? "Collection key"
									: `Title #${k.file_id}`);
							return (
								<li
									key={k.id}
									className="flex flex-wrap items-center justify-between gap-3 px-6 py-3"
								>
									<div className="min-w-0 space-y-1">
										<div className="flex items-center gap-2">
											<span className="truncate font-medium">{name}</span>
											<Badge variant="outline">
												{k.scope === "collection"
													? "Collection"
													: "Single title"}
											</Badge>
											{k.bound_ip && (
												<Badge variant="secondary">{k.bound_ip}</Badge>
											)}
										</div>
										<p className="text-xs text-muted-foreground">
											Expires {formatDateTime(k.expires_at)} ·{" "}
											{k.last_used_at
												? `last used ${relativeTime(k.last_used_at)}`
												: "never used"}
										</p>
									</div>
									<Button
										variant="ghost"
										size="sm"
										onClick={() => onRevoke(k.id, name)}
										disabled={revoke.isPending}
									>
										<Trash2 className="size-4" />
										Revoke
									</Button>
								</li>
							);
						})}
					</ul>
				)}
			</CardContent>
		</Card>
	);
}
