import { useQuery } from "@tanstack/react-query";
import { AlertCircle, Check, ShieldCheck, X } from "lucide-react";
import { useState } from "react";
import { Navigate, useSearchParams } from "react-router-dom";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
	Card,
	CardContent,
	CardDescription,
	CardFooter,
	CardHeader,
	CardTitle,
} from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { errorMessage } from "@/config/api";
import { useAuth } from "@/features/auth/hooks/auth";
import { oauthService } from "../services/oauthService";
import type { ConsentScope } from "../types";

/** Human wording for each scope. Unknown scopes fall back to their raw name --
 * the backend is the authority on which exist, and this map only affects
 * presentation. */
const SCOPE_LABELS: Record<string, string> = {
	profile: "See your username and role",
	"files:read": "List and download your files",
	"files:write": "Upload files to your account",
	"directories:read": "List your folders",
	"media:read": "Browse and stream your media library",
};

function ScopeRow({ scope }: { scope: ConsentScope }) {
	return (
		<li className="flex items-start gap-2.5 py-1.5">
			{scope.granted ? (
				<Check className="mt-0.5 size-4 shrink-0 text-success" />
			) : (
				<X className="mt-0.5 size-4 shrink-0 text-destructive" />
			)}
			<div className="min-w-0">
				<p className="text-sm">{SCOPE_LABELS[scope.scope] ?? scope.scope}</p>
				<p className="mt-0.5 flex items-center gap-1.5 text-xs text-muted-foreground">
					<code className="font-mono">{scope.scope}</code>
					{!scope.granted && (
						<Badge variant="secondary">
							you lack {scope.requires ?? "the required permission"}
						</Badge>
					)}
				</p>
			</div>
		</li>
	);
}

/** OAuth consent screen (`/oauth/authorize`). The query string is handed to the
 * backend verbatim — it validates client_id, redirect_uri, scope and PKCE, and
 * returns the URL to bounce to for both approval and denial, so this page never
 * builds a redirect itself. */
export function AuthorizePage() {
	const [searchParams] = useSearchParams();
	const { user, isLoading: authLoading } = useAuth();
	const [submitting, setSubmitting] = useState<"approve" | "deny" | null>(null);
	const [decisionError, setDecisionError] = useState<string | null>(null);

	const params = Object.fromEntries(searchParams.entries());

	const info = useQuery({
		queryKey: ["oauth", "consent", searchParams.toString()],
		queryFn: () => oauthService.consentInfo(params),
		enabled: !!user,
		retry: false,
	});

	if (authLoading) return null;
	// Preserve the whole request across the login round-trip: without the query
	// string the consent request is unrecoverable and the app has to start over.
	if (!user) {
		const next = `/oauth/authorize?${searchParams.toString()}`;
		return <Navigate to={`/login?next=${encodeURIComponent(next)}`} replace />;
	}

	const decide = async (approve: boolean) => {
		setSubmitting(approve ? "approve" : "deny");
		setDecisionError(null);
		try {
			const { redirect_to } = await oauthService.decide(params, approve);
			// A full navigation, not a router push: the destination belongs to the
			// third-party app, not to this SPA.
			window.location.replace(redirect_to);
		} catch (err) {
			setDecisionError(errorMessage(err));
			setSubmitting(null);
		}
	};

	const ungranted = info.data?.scopes.filter((s) => !s.granted) ?? [];

	return (
		<div className="mx-auto flex min-h-svh max-w-lg items-center px-4 py-10">
			<Card className="w-full">
				<CardHeader>
					<CardTitle className="flex items-center gap-2">
						<ShieldCheck className="size-5 text-muted-foreground" />
						Authorize application
					</CardTitle>
					<CardDescription>
						{info.data
							? `${info.data.client.name} wants to access your account as ${user.username}.`
							: "Checking the request…"}
					</CardDescription>
				</CardHeader>

				<CardContent className="space-y-4">
					{info.isLoading && (
						<div className="space-y-2">
							<Skeleton className="h-5 w-2/3" />
							<Skeleton className="h-5 w-1/2" />
							<Skeleton className="h-5 w-3/5" />
						</div>
					)}

					{info.isError && (
						<p className="flex items-start gap-2 rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
							<AlertCircle className="mt-0.5 size-4 shrink-0" />
							{errorMessage(info.error)}
						</p>
					)}

					{info.data && (
						<>
							<div>
								<p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
									This will allow it to
								</p>
								<ul className="mt-1 divide-y divide-border">
									{info.data.scopes.map((scope) => (
										<ScopeRow key={scope.scope} scope={scope} />
									))}
								</ul>
							</div>

							{ungranted.length > 0 && (
								<p className="flex items-start gap-2 rounded-md border border-warning/30 bg-warning/10 px-3 py-2 text-xs text-warning">
									<AlertCircle className="mt-0.5 size-4 shrink-0" />
									You can't grant permissions you don't hold yourself. Ask an
									administrator, or deny this request.
								</p>
							)}

							<div className="rounded-md border border-border bg-background/40 px-3 py-2 text-xs text-muted-foreground">
								<p>
									Registered by{" "}
									<span className="font-medium">
										{info.data.client.owner_username ?? "an unknown user"}
									</span>
								</p>
								<p className="mt-1 break-all">
									Redirects to <code>{info.data.redirect_uri}</code>
								</p>
							</div>
						</>
					)}

					{decisionError && (
						<p className="flex items-start gap-2 rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
							<AlertCircle className="mt-0.5 size-4 shrink-0" />
							{decisionError}
						</p>
					)}
				</CardContent>

				<CardFooter className="justify-end gap-2">
					<Button
						variant="ghost"
						onClick={() => decide(false)}
						loading={submitting === "deny"}
						disabled={!info.data || submitting !== null}
					>
						Deny
					</Button>
					<Button
						onClick={() => decide(true)}
						loading={submitting === "approve"}
						disabled={!info.data || submitting !== null || ungranted.length > 0}
					>
						Allow access
					</Button>
				</CardFooter>
			</Card>
		</div>
	);
}
