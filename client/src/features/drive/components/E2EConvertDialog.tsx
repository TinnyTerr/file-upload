import { ShieldAlert } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
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
import { Progress } from "@/components/ui/progress";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/ui/select";
import {
	deriveSealKey,
	isSupportedSealKdf,
} from "@/features/files/lib/sealKey";
import type { FileObject } from "@/features/files/types";
import { base64UrlToBytes } from "@/lib/base64url";
import { useE2EConversion } from "../hooks/useEncryption";
import type { RevealedKey } from "./SealKeyDialog";

/** Strip the key out of a pasted share URL, or take it as-is. */
function extractKey(value: string): string {
	const trimmed = value.trim();
	const idx = trimmed.indexOf("#ek=");
	if (idx === -1) return trimmed;
	return trimmed.slice(idx + 4).split(/[?&#]/)[0];
}

/**
 * The download → transform → re-upload wizard for one file.
 *
 * Going *into* end-to-end needs nothing from the user: the server can still
 * read the file, so the browser just re-encrypts it. Coming *out* needs the
 * key, because nothing on the server can supply it — either the raw key from
 * the share fragment, or the password a Seal & Forget was derived from.
 */
export function E2EConvertDialog({
	file,
	open,
	onOpenChange,
	onRevealed,
}: {
	file: FileObject;
	open: boolean;
	onOpenChange: (open: boolean) => void;
	onRevealed: (revealed: RevealedKey) => void;
}) {
	const { convert, progress, busy } = useE2EConversion();
	const [keyInput, setKeyInput] = useState("");
	const [target, setTarget] = useState<"none" | "server">("server");
	const [error, setError] = useState<string | null>(null);

	const locked =
		file.encryption_mode === "client" || file.encryption_mode === "sealed";
	// A password-sealed file rebuilds its key from the password plus the salt
	// the row carries; a randomly sealed one takes the raw key instead.
	const passwordSealed = isSupportedSealKdf(file.seal_kdf) && !!file.seal_salt;

	const run = async () => {
		setError(null);
		try {
			let currentKey: Uint8Array | null = null;
			if (locked) {
				if (!keyInput.trim()) {
					setError("The key this file was encrypted with is required.");
					return;
				}
				currentKey =
					passwordSealed && file.seal_salt && file.seal_kdf
						? await deriveSealKey(keyInput, file.seal_salt, file.seal_kdf)
						: base64UrlToBytes(extractKey(keyInput));
			}
			const result = await convert({
				file,
				target: locked ? target : "client",
				currentKey,
			});
			if (!result) return;
			setKeyInput("");
			onOpenChange(false);
			if (result.clientKeyB64) {
				onRevealed({
					subject: `“${file.original_filename}”`,
					key: result.clientKeyB64,
					isPassword: false,
					reason:
						"it was encrypted in your browser and the key never reached the server.",
				});
			}
		} catch (err) {
			setError(err instanceof Error ? err.message : "Conversion failed");
		}
	};

	return (
		<Dialog open={open} onOpenChange={(o) => !busy && onOpenChange(o)}>
			<DialogContent className="max-w-md">
				<DialogHeader>
					<DialogTitle className="flex items-center gap-2">
						<ShieldAlert className="size-4" />
						{locked ? "Decrypt permanently" : "Convert to end-to-end"}
					</DialogTitle>
					<DialogDescription>
						{locked
							? "Your browser decrypts the file and uploads the plaintext again. The server sees the contents at that moment — that transition is written to the audit log."
							: "Your browser encrypts the file with a new key and uploads it again. The key is shown once and never reaches the server."}
					</DialogDescription>
				</DialogHeader>

				{locked && (
					<>
						<div className="space-y-1.5">
							<Label htmlFor="convert-key">
								{passwordSealed ? "Seal password" : "Current key"}
							</Label>
							<Input
								id="convert-key"
								type={passwordSealed ? "password" : "text"}
								autoComplete="off"
								placeholder={
									passwordSealed
										? "The password it was sealed with"
										: "#ek=… or the key itself"
								}
								value={keyInput}
								onChange={(e) => setKeyInput(e.target.value)}
							/>
						</div>
						<div className="space-y-1.5">
							<Label>Afterwards</Label>
							<Select
								value={target}
								onValueChange={(v) => setTarget(v as typeof target)}
							>
								<SelectTrigger>
									<SelectValue />
								</SelectTrigger>
								<SelectContent>
									<SelectItem value="server">
										Server-side (?ek=) encrypted
									</SelectItem>
									<SelectItem value="none">Not encrypted</SelectItem>
								</SelectContent>
							</Select>
						</div>
					</>
				)}

				{progress && (
					<div className="space-y-1.5">
						<Progress value={progress.percent} />
						<p className="text-xs text-muted-foreground">
							{progress.phase} · {progress.filename}
						</p>
					</div>
				)}
				{error && <p className="text-sm text-destructive">{error}</p>}

				<DialogFooter>
					<Button
						variant="ghost"
						onClick={() => onOpenChange(false)}
						disabled={busy}
					>
						Cancel
					</Button>
					<Button onClick={run} loading={busy}>
						{locked ? "Decrypt and replace" : "Encrypt and replace"}
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}
