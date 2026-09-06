import { AlertTriangle, Download, KeyRound } from "lucide-react";
import type * as React from "react";
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
import { saveBlob } from "@/lib/download";
import type { RevealedKey } from "../hooks/useRevealedKeys";

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
 *
 * Rendered once, at the app root, by `RevealedKeyProvider` — never by the
 * component that produced the key, which the same mutation may be unmounting.
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

	const onSubmit = (e: React.FormEvent) => {
		e.preventDefault();
		if (canClose) close();
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

				<form id="seal-key-form" onSubmit={onSubmit} className="space-y-4">
					<div className="flex items-start gap-2 rounded-md border border-warning/40 bg-warning/10 px-3 py-2 text-xs text-warning">
						<AlertTriangle className="mt-0.5 size-4 shrink-0" />
						<span>
							Without this {revealed.isPassword ? "password" : "key"} the
							contents cannot be recovered by you, by an administrator, or by
							anyone with access to the database or the disk.
						</span>
					</div>

					{revealed.incomplete && (
						<div className="flex items-start gap-2 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive">
							<AlertTriangle className="mt-0.5 size-4 shrink-0" />
							<span>
								The converted copy is safe and this key opens it, but removing
								the original failed. Delete the leftover copy by hand once
								you've saved this.
							</span>
						</div>
					)}

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
								{/* The retype gate is the only way out of this dialog, so a
							    browser that blocks clipboard writes would otherwise trap the
							    user here with a key they can't save. */}
								<Button
									type="button"
									variant="ghost"
									size="icon"
									className="size-7 shrink-0"
									aria-label="Download the key as a text file"
									onClick={() =>
										saveBlob(
											new Blob([`${revealed.subject}\n\n${revealed.key}\n`], {
												type: "text/plain",
											}),
											"fileupload-key.txt",
										)
									}
								>
									<Download className="size-4" />
								</Button>
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
				</form>

				<DialogFooter>
					<Button type="submit" form="seal-key-form" disabled={!canClose}>
						I've saved it
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}
