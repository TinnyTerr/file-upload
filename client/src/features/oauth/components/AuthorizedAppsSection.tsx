import { ShieldCheck, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
	Card,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
} from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { ListRow } from "@/components/ui/list-row";
import { Skeleton } from "@/components/ui/skeleton";
import { Tooltip } from "@/components/ui/tooltip";
import { formatDate, relativeTime } from "@/lib/time";
import { useDialogs } from "@/providers/DialogProvider";
import { useOauthAuthorizations } from "../hooks/useOauthApps";

/** The consenting side: apps this user has granted access to, and the button
 * that takes it away. */
export function AuthorizedAppsSection() {
	const { list, revoke } = useOauthAuthorizations();
	const { confirm } = useDialogs();

	const onRevoke = async (clientId: string, name: string | null) => {
		const ok = await confirm({
			title: `Revoke ${name ?? clientId}?`,
			description:
				"The app loses access immediately. It can ask for access again unless you also delete it.",
			confirmText: "Revoke",
			destructive: true,
		});
		if (ok) revoke.mutate(clientId);
	};

	return (
		<Card>
			<CardHeader>
				<CardTitle>Authorized apps</CardTitle>
				<CardDescription>
					Applications acting on your behalf through OAuth.
				</CardDescription>
			</CardHeader>
			<CardContent>
				{list.isLoading ? (
					<div className="space-y-2">
						<Skeleton className="h-12 w-full" />
					</div>
				) : !list.data || list.data.length === 0 ? (
					<EmptyState
						icon={ShieldCheck}
						title="No authorized apps"
						description="Apps you approve will be listed here."
					/>
				) : (
					<div className="space-y-2">
						{list.data.map((authz) => (
							<ListRow
								key={authz.client_id}
								leading={
									<ShieldCheck className="size-4 shrink-0 text-muted-foreground" />
								}
								trailing={
									<Tooltip content="Revoke access">
										<Button
											variant="ghost"
											size="icon"
											className="text-destructive"
											onClick={() => onRevoke(authz.client_id, authz.name)}
											aria-label={`Revoke access for ${authz.name ?? authz.client_id}`}
										>
											<Trash2 />
										</Button>
									</Tooltip>
								}
							>
								<span className="text-sm font-medium">
									{authz.name ?? authz.client_id}
								</span>
								<p className="mt-0.5 font-mono text-xs text-muted-foreground">
									{authz.scopes.join(" ")}
								</p>
								<p className="mt-0.5 text-xs text-muted-foreground">
									Authorized {formatDate(authz.authorized_at)} · last used{" "}
									{relativeTime(authz.last_used_at)}
								</p>
							</ListRow>
						))}
					</div>
				)}
			</CardContent>
		</Card>
	);
}
