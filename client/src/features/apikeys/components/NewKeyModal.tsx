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
import type { NewApiKey } from "../types";

/** Shows a freshly-created API key exactly once. */
export function NewKeyModal({
	apiKey,
	onClose,
}: {
	apiKey: NewApiKey | null;
	onClose: () => void;
}) {
	return (
		<Dialog open={!!apiKey} onOpenChange={(o) => !o && onClose()}>
			<DialogContent className="max-w-md">
				<DialogHeader>
					<DialogTitle>API key #{apiKey?.user_key_number}</DialogTitle>
					<DialogDescription>
						Copy it now — it will never be shown again.
					</DialogDescription>
				</DialogHeader>

				<p className="flex items-start gap-2 rounded-md border border-warning/30 bg-warning/10 px-3 py-2 text-xs text-warning">
					<AlertTriangle className="mt-0.5 size-4 shrink-0" />
					Store this key securely. If you lose it, delete it and create a new
					one.
				</p>

				{apiKey && (
					<div className="flex items-center gap-2 rounded-md border border-border bg-background/40 px-2.5 py-2">
						<code className="flex-1 break-all font-mono text-xs">
							{apiKey.key}
						</code>
						<CopyButton value={apiKey.key} />
					</div>
				)}

				<DialogFooter>
					<Button onClick={onClose}>Done</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}
