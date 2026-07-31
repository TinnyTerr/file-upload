import { useQuery } from "@tanstack/react-query";
import { ShieldAlert } from "lucide-react";
import * as React from "react";
import { useNavigate } from "react-router-dom";
import { Button } from "@/components/ui/button";
import {
	Card,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
} from "@/components/ui/card";
import { useAuth } from "@/features/auth/hooks/auth";
import { mfaService } from "../services/mfaService";
import { SecurityTab } from "./SecurityTab";

/** Forced-enrollment landing page. An account carrying `require_mfa` or
 * `require_passkey` without the matching credential gets a 403 from every
 * authenticated endpoint, so this is the only page it can reach — it hosts the
 * same enrollment UI as the settings modal's Security tab and lets itself out
 * again as soon as the requirement is met. Also where login sends a master
 * with no second factor enrolled, who is nagged rather than blocked. */
export function MfaSetupPage() {
	const { mfaEnrollmentRequired, refresh, logout } = useAuth();
	const navigate = useNavigate();
	const blocked = mfaEnrollmentRequired !== null;
	const needsPasskey = mfaEnrollmentRequired === "passkey";

	const { data: credentials } = useQuery({
		queryKey: ["account", "mfa"],
		queryFn: mfaService.list,
	});

	const satisfied = needsPasskey
		? (credentials?.some((c) => c.kind === "webauthn") ?? false)
		: (credentials?.length ?? 0) > 0;

	// Enrolling clears the block server-side; re-running /account/me is what
	// tells the guard to stop pinning this account to this page.
	React.useEffect(() => {
		if (satisfied && blocked) void refresh();
	}, [satisfied, blocked, refresh]);

	React.useEffect(() => {
		if (satisfied && !blocked) navigate("/files", { replace: true });
	}, [satisfied, blocked, navigate]);

	return (
		<div className="mx-auto max-w-lg space-y-4">
			<Card>
				<CardHeader>
					<CardTitle className="flex items-center gap-2">
						<ShieldAlert className="size-5 text-warning" />
						{needsPasskey ? "A passkey is required" : "Two-factor is required"}
					</CardTitle>
					<CardDescription>
						{needsPasskey
							? "This account must sign in with a passkey. Add one below to continue — an authenticator app alone will not unlock it."
							: "This account must use two-factor authentication. Add an authenticator app or a passkey below to continue."}
					</CardDescription>
				</CardHeader>
				<CardContent>
					<SecurityTab />
				</CardContent>
			</Card>
			<div className="flex justify-between gap-2">
				<Button variant="ghost" onClick={() => void logout()}>
					Sign out
				</Button>
				<Button
					disabled={blocked && !satisfied}
					onClick={async () => {
						await refresh();
						navigate("/files", { replace: true });
					}}
				>
					Continue
				</Button>
			</div>
		</div>
	);
}
