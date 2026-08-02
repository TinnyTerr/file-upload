import { AppWindow, Plus, Trash2 } from "lucide-react";
import { useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
	Card,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
} from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { EmptyState } from "@/components/ui/empty-state";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ListRow } from "@/components/ui/list-row";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { Tooltip } from "@/components/ui/tooltip";
import { useAuth } from "@/features/auth/hooks/auth";
import { formatDate } from "@/lib/time";
import { useDialogs } from "@/providers/DialogProvider";
import { useOauthApps } from "../hooks/useOauthApps";
import type { NewOauthApp } from "../types";
import { NewAppModal } from "./NewAppModal";

/** Mirrors security/oauth.ts's SCOPES. The backend rejects anything it doesn't
 * recognize, so this list is only about what the form offers. */
const SCOPE_OPTIONS = [
	{ scope: "profile", label: "Read your username and role" },
	{ scope: "files:read", label: "List and download files" },
	{ scope: "files:write", label: "Upload files" },
	{ scope: "directories:read", label: "List folders" },
	{ scope: "media:read", label: "Browse and stream media" },
];

/** Developer-side OAuth: register an app, get a client_id (and a secret for
 * confidential clients), delete it again. */
export function OauthAppsSection() {
	const { can } = useAuth();
	const { list, create, deleteApp } = useOauthApps();
	const { confirm } = useDialogs();
	const [open, setOpen] = useState(false);
	const [created, setCreated] = useState<NewOauthApp | null>(null);
	const [name, setName] = useState("");
	const [redirectUris, setRedirectUris] = useState("");
	const [confidential, setConfidential] = useState(true);
	const [scopes, setScopes] = useState<string[]>(["profile", "files:read"]);

	if (!can("can_use_api_keys")) return null;

	const reset = () => {
		setName("");
		setRedirectUris("");
		setConfidential(true);
		setScopes(["profile", "files:read"]);
		setOpen(false);
	};

	const onCreate = async () => {
		const uris = redirectUris
			.split("\n")
			.map((u) => u.trim())
			.filter(Boolean);
		const app = await create.mutateAsync({
			name: name.trim(),
			redirect_uris: uris,
			scopes,
			confidential,
		});
		reset();
		setCreated(app);
	};

	const onDelete = async (clientId: string, appName: string) => {
		const ok = await confirm({
			title: `Delete ${appName}?`,
			description:
				"Every access and refresh token issued to this app is revoked immediately, and anyone who authorized it will have to do so again.",
			confirmText: "Delete",
			destructive: true,
		});
		if (ok) deleteApp.mutate(clientId);
	};

	const canSubmit =
		name.trim().length > 0 &&
		redirectUris.trim().length > 0 &&
		scopes.length > 0;

	return (
		<>
			<Card>
				<CardHeader className="flex-row items-center justify-between gap-2 space-y-0">
					<div>
						<CardTitle>OAuth apps</CardTitle>
						<CardDescription>
							Apps you've registered, for other people to authorize.
						</CardDescription>
					</div>
					<Button size="sm" onClick={() => setOpen((o) => !o)}>
						<Plus /> New app
					</Button>
				</CardHeader>
				<CardContent className="space-y-4">
					{open && (
						<div className="space-y-4 rounded-md border border-border p-3">
							<div className="space-y-1.5">
								<Label htmlFor="oauth-app-name">Name</Label>
								<Input
									id="oauth-app-name"
									value={name}
									onChange={(e) => setName(e.target.value)}
									placeholder="My backup script"
								/>
							</div>
							<div className="space-y-1.5">
								<Label htmlFor="oauth-app-uris">Redirect URIs</Label>
								<textarea
									id="oauth-app-uris"
									value={redirectUris}
									onChange={(e) => setRedirectUris(e.target.value)}
									rows={3}
									spellCheck={false}
									placeholder={
										"https://app.example.com/callback\nhttp://localhost:8765/callback"
									}
									className="w-full rounded-md border border-border bg-background/40 px-2.5 py-2 font-mono text-xs outline-none focus-visible:ring-2 focus-visible:ring-ring"
								/>
								<p className="text-xs text-muted-foreground">
									One per line. Matched exactly — https, loopback http, or a
									private-use scheme.
								</p>
							</div>
							<div className="space-y-1.5">
								<Label>Scopes</Label>
								<div className="space-y-1.5">
									{SCOPE_OPTIONS.map((opt) => (
										<label
											key={opt.scope}
											className="flex items-center gap-2.5 text-sm"
										>
											<Checkbox
												checked={scopes.includes(opt.scope)}
												onCheckedChange={(checked) =>
													setScopes((prev) =>
														checked
															? [...prev, opt.scope]
															: prev.filter((s) => s !== opt.scope),
													)
												}
											/>
											<span>{opt.label}</span>
											<code className="font-mono text-xs text-muted-foreground">
												{opt.scope}
											</code>
										</label>
									))}
								</div>
							</div>
							<div className="flex items-center justify-between gap-3">
								<div>
									<Label htmlFor="oauth-app-confidential">
										Confidential client
									</Label>
									<p className="text-xs text-muted-foreground">
										Off for mobile/CLI apps that can't keep a secret — those
										must use PKCE.
									</p>
								</div>
								<Switch
									id="oauth-app-confidential"
									checked={confidential}
									onCheckedChange={setConfidential}
								/>
							</div>
							<div className="flex justify-end gap-2">
								<Button variant="ghost" size="sm" onClick={reset}>
									Cancel
								</Button>
								<Button
									size="sm"
									onClick={onCreate}
									loading={create.isPending}
									disabled={!canSubmit}
								>
									Register
								</Button>
							</div>
						</div>
					)}

					{list.isLoading ? (
						<div className="space-y-2">
							<Skeleton className="h-12 w-full" />
							<Skeleton className="h-12 w-full" />
						</div>
					) : !list.data || list.data.length === 0 ? (
						<EmptyState
							icon={AppWindow}
							title="No OAuth apps"
							description="Register one to let an application act on a user's behalf."
						/>
					) : (
						<div className="space-y-2">
							{list.data.map((app) => (
								<ListRow
									key={app.id}
									leading={
										<AppWindow className="size-4 shrink-0 text-muted-foreground" />
									}
									trailing={
										<Tooltip content="Delete app">
											<Button
												variant="ghost"
												size="icon"
												className="text-destructive"
												onClick={() => onDelete(app.client_id, app.name)}
												aria-label={`Delete OAuth app ${app.name}`}
											>
												<Trash2 />
											</Button>
										</Tooltip>
									}
								>
									<div className="flex flex-wrap items-center gap-2">
										<span className="text-sm font-medium">{app.name}</span>
										<Badge variant={app.confidential ? "accent" : "secondary"}>
											{app.confidential ? "confidential" : "public (PKCE)"}
										</Badge>
									</div>
									<p className="mt-0.5 break-all font-mono text-xs text-muted-foreground">
										{app.client_id}
									</p>
									<p className="mt-0.5 text-xs text-muted-foreground">
										{app.scopes.join(" ")} · created{" "}
										{formatDate(app.created_at)}
									</p>
								</ListRow>
							))}
						</div>
					)}
				</CardContent>
			</Card>

			<NewAppModal app={created} onClose={() => setCreated(null)} />
		</>
	);
}
