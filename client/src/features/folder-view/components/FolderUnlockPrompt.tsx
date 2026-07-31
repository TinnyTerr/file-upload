import { ArrowLeft, KeyRound, Lock } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import type { EncryptionMode } from "@/features/files/types";

/**
 * Shown instead of a folder's contents when the visitor doesn't hold its key.
 *
 * A folder link can lead to a subfolder that broke away with a key of its own,
 * and the visitor may simply not have been given it. `onBack` is always
 * offered so that is a wrong turn rather than a dead end.
 */
export function FolderUnlockPrompt({
	title,
	mode,
	passwordLocked,
	onUnlock,
	onBack,
}: {
	title: string;
	mode: EncryptionMode;
	passwordLocked: boolean;
	onUnlock: (value: string) => Promise<void>;
	/** Null at the entry folder — there is nowhere further back to go. */
	onBack: (() => void) | null;
}) {
	const [value, setValue] = useState("");
	const [error, setError] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);

	const endToEnd = mode === "client" || mode === "sealed";

	const submit = async () => {
		setError(null);
		setBusy(true);
		try {
			await onUnlock(value);
			setValue("");
		} catch (err) {
			setError(
				err instanceof Error ? err.message : "That didn't open this folder.",
			);
		} finally {
			setBusy(false);
		}
	};

	return (
		<Card>
			<CardContent className="space-y-4 p-6">
				<div className="flex items-start gap-3">
					<div className="flex size-11 shrink-0 items-center justify-center rounded-xl bg-secondary/50">
						<Lock className="size-5 text-muted-foreground" />
					</div>
					<div className="min-w-0">
						<h2 className="break-words text-lg font-semibold">“{title}”</h2>
						<p className="mt-0.5 text-sm text-muted-foreground">
							{endToEnd
								? "This folder is end-to-end encrypted with its own key. Only someone who was given that key can open it — the server can't."
								: passwordLocked
									? "This folder is locked with a password of its own."
									: "This folder has its own access key, separate from the one that got you here."}
						</p>
					</div>
				</div>

				<div className="space-y-1.5">
					<Label htmlFor="folder-unlock">
						{passwordLocked ? "Password" : "Key"}
					</Label>
					<div className="flex gap-2">
						<Input
							id="folder-unlock"
							autoFocus
							type={passwordLocked ? "password" : "text"}
							placeholder={
								passwordLocked
									? "The password you were given"
									: endToEnd
										? "#ek=… or the key itself"
										: "?ek=… or the key itself"
							}
							value={value}
							onChange={(e) => setValue(e.target.value)}
							onKeyDown={(e) => {
								if (e.key === "Enter") submit();
							}}
						/>
						<Button onClick={submit} loading={busy} disabled={!value.trim()}>
							<KeyRound /> Unlock
						</Button>
					</div>
					{error && <p className="text-sm text-destructive">{error}</p>}
					{passwordLocked && (
						<p className="text-xs text-muted-foreground">
							Repeated wrong guesses lock this link out for a while.
						</p>
					)}
				</div>

				{onBack && (
					<Button variant="ghost" onClick={onBack}>
						<ArrowLeft /> Back
					</Button>
				)}
			</CardContent>
		</Card>
	);
}
