import { AlertTriangle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { CopyButton } from "@/components/ui/copy-button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@/components/ui/dialog";
import type { NewOauthApp } from "../types";

function Field({ label, value }: { label: string; value: string }) {
	return (
		<div>
			<p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
				{label}
			</p>
			<div className="mt-1 flex items-center gap-2 rounded-md border border-border bg-background/40 px-2.5 py-2">
				<code className="flex-1 break-all font-mono text-xs">{value}</code>
				<CopyButton value={value} />
			</div>
		</div>
	);
}

/** Shows a newly registered app's credentials. The client secret is displayed
 * exactly once — only its hash is stored. */
export function NewAppModal({
	app,
	onClose,
}: {
	app: NewOauthApp | null;
	onClose: () => void;
}) {
	return (
		<Dialog open={!!app} onOpenChange={(o) => !o && onClose()}>
			<DialogContent className="max-w-md">
				<DialogHeader>
					<DialogTitle>{app?.name}</DialogTitle>
					<DialogDescription>
						{app?.client_secret
							? "Copy the secret now — it will never be shown again."
							: "A public client: it has no secret and must use PKCE."}
					</DialogDescription>
				</DialogHeader>

				{app && (
					<div className="space-y-3">
						<Field label="Client ID" value={app.client_id} />
						{app.client_secret && (
							<>
								<p className="flex items-start gap-2 rounded-md border border-warning/30 bg-warning/10 px-3 py-2 text-xs text-warning">
									<AlertTriangle className="mt-0.5 size-4 shrink-0" />
									Store this secret securely. If you lose it, delete the app and
									register a new one.
								</p>
								<Field label="Client secret" value={app.client_secret} />
							</>
						)}
					</div>
				)}

				<DialogFooter>
					<Button onClick={onClose}>Done</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}
