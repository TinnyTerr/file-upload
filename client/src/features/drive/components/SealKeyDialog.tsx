import { AlertTriangle, KeyRound } from "lucide-react";
import { useState } from "react";
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
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

export interface RevealedKey {
	/** What the key opens — a filename, or "5 files in Photos". */
	subject: string;
	key: string;
	/** Derived from a password the user chose, rather than random. */
	isPassword: boolean;
	/** Why there is no second copy. Differs between a seal and an E2E convert. */
	reason: string;
}

/**
 * The key a seal produced, shown exactly once.
 *
 * There is genuinely no second copy — the server discarded it before this
 * response was written — so the dialog refuses to close until the key has been
 * typed back. That is friction on purpose: an accidental dismissal here means
 * the file is gone for good.
 *
 * A password-derived seal skips the retype (the user chose the password and
 * already knows it) but keeps the same warning.
 */
export function SealKeyDialog({
	revealed,
	onClose,
}: {
	revealed: RevealedKey | null;
	onClose: () => void;
}) {
	const [confirmation, setConfirmation] = useState("");

	if (!revealed) return null;
	const matches = confirmation.trim() === revealed.key;
	const canClose = revealed.isPassword || matches;

	const close = () => {
		setConfirmation("");
		onClose();
	};

	return (
		<Dialog
			open
			onOpenChange={(open) => {
				// Escape and click-outside must not be a way to lose the key.
				if (!open && canClose) close();
			}}
		>
			<DialogContent className="max-w-md">
				<DialogHeader>
					<DialogTitle className="flex items-center gap-2">
						<KeyRound className="size-4" /> Save this key now
					</DialogTitle>
					<DialogDescription>
						{revealed.subject} — {revealed.reason} This is the only time the key
						will ever be shown.
					</DialogDescription>
				</DialogHeader>

				<div className="flex items-start gap-2 rounded-md border border-warning/40 bg-warning/10 px-3 py-2 text-xs text-warning">
					<AlertTriangle className="mt-0.5 size-4 shrink-0" />
					<span>
						Without this {revealed.isPassword ? "password" : "key"} the contents
						cannot be recovered by you, by an administrator, or by anyone with
						access to the database or the disk.
					</span>
				</div>

				{revealed.isPassword ? (
					<p className="text-sm text-muted-foreground">
						The key was derived from the password you chose. Keep it somewhere
						you'll still have it later.
					</p>
				) : (
					<>
						<div className="flex items-center gap-2 rounded-md border border-border bg-background/40 px-2.5 py-2">
							<code className="flex-1 break-all font-mono text-xs leading-relaxed">
								{revealed.key}
							</code>
							<CopyButton value={revealed.key} className="shrink-0" />
						</div>
						<div className="space-y-1.5">
							<Label htmlFor="seal-confirm">Type it back to confirm</Label>
							<Input
								id="seal-confirm"
								autoComplete="off"
								placeholder="Paste or type the key"
								value={confirmation}
								onChange={(e) => setConfirmation(e.target.value)}
							/>
							{confirmation && !matches && (
								<p className="text-xs text-destructive">
									That doesn't match yet.
								</p>
							)}
						</div>
					</>
				)}

				<DialogFooter>
					<Button onClick={close} disabled={!canClose}>
						I've saved it
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}
