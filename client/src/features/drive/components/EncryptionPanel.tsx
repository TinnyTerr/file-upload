import {
	CornerLeftUp,
	Info,
	Link2Off,
	Lock,
	ShieldAlert,
	ShieldCheck,
} from "lucide-react";
import { useState } from "react";
import { Link } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { CopyButton } from "@/components/ui/copy-button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/ui/select";
import {
	Sheet,
	SheetContent,
	SheetDescription,
	SheetTitle,
} from "@/components/ui/sheet";
import { useAuth } from "@/features/auth/hooks/auth";
import { EncryptionBadge } from "@/features/files/lib/fileMeta";
import type { EncryptionMode } from "@/features/files/types";
import { bytesToBase64Url, randomKey } from "@/lib/base64url";
import { useDriveChildren } from "../hooks/useDrive";
import { useE2EConversion, useEncryption } from "../hooks/useEncryption";
import { type KeyRef, useRevealedKeys } from "../hooks/useRevealedKeys";
import { type DriveItem, itemName } from "../lib/items";
import { drivePath } from "../types";
import { E2EConvertDialog } from "./E2EConvertDialog";

const MIN_PASSWORD = 8;

function Section({
	title,
	children,
	hint,
}: {
	title: string;
	children: React.ReactNode;
	hint?: string;
}) {
	return (
		<section className="space-y-2 border-t border-border pt-4">
			<h3 className="text-sm font-semibold">{title}</h3>
			{hint && <p className="text-xs text-muted-foreground">{hint}</p>}
			{children}
		</section>
	);
}

/** Everything about what protects one folder or one file, in one place. */
export function EncryptionPanel({
	item,
	open,
	onOpenChange,
}: {
	item: DriveItem | null;
	open: boolean;
	onOpenChange: (open: boolean) => void;
}) {
	const encryption = useEncryption();
	const conversion = useE2EConversion();
	const { reveal } = useRevealedKeys();
	const { user, can } = useAuth();
	const [nextMode, setNextMode] = useState<"none" | "server" | "inherit">(
		"server",
	);
	const [modePassword, setModePassword] = useState("");
	const [accessPassword, setAccessPassword] = useState("");
	const [sealPassword, setSealPassword] = useState("");
	const [convertOpen, setConvertOpen] = useState(false);
	const [batch, setBatch] = useState<{ done: number; total: number } | null>(
		null,
	);

	// Only used when the panel is open on a folder, for the batch convert --
	// `enabled` matters, or opening the panel on a *file* fetches the whole root
	// listing for nothing.
	const children = useDriveChildren(
		item?.kind === "folder" ? item.id : "root",
		item?.kind === "folder",
	);

	if (!item) return null;

	const isFolder = item.kind === "folder";
	const mode: EncryptionMode = isFolder
		? item.dir.encryption_mode
		: item.file.encryption_mode;
	const overridden = isFolder
		? item.dir.encryption_overridden
		: item.file.encryption_overridden;
	const inheritedFrom = isFolder
		? item.dir.inherited_from_directory_id
		: item.file.inherited_from_directory_id;
	const passwordLocked = isFolder
		? item.dir.password_locked
		: item.file.password_locked;
	const accessKey = isFolder ? item.dir.access_key : item.file.access_key;
	const parentId = isFolder
		? item.dir.parent_directory_id
		: item.file.directory_id;
	const serverManaged = mode === "none" || mode === "server";
	const canAdopt = parentId !== null && overridden;

	// The seal route takes the *delete* gate, not the edit gate, plus ownership
	// (server/src/routes/files.ts). Rendering the section without checking meant
	// a collaborator got a 403 toast and no dialog — which is what "the popup
	// never comes up" looks like from the outside.
	const isOwner =
		!isFolder &&
		(user?.role === "master" || (!!user && item.file.owner_id === user.id));
	const canSeal = !isFolder && can("can_delete") && isOwner;
	// A password shorter than the minimum is not "no password": the server would
	// mint a random key instead, and the user would walk away believing they
	// sealed the file with something they can remember.
	const sealPasswordOk =
		sealPassword.length === 0 || sealPassword.length >= MIN_PASSWORD;

	const applyMode = async () => {
		if (nextMode === "inherit") {
			await encryption.setEncryption(item, { adopt_parent: true });
			return;
		}
		if (
			nextMode === "server" &&
			modePassword &&
			modePassword.length < MIN_PASSWORD
		) {
			return;
		}
		await encryption.setEncryption(item, {
			mode: nextMode,
			password: nextMode === "server" && modePassword ? modePassword : null,
		});
		setModePassword("");
	};

	const doSeal = async () => {
		if (isFolder || !sealPasswordOk) return;
		const usePassword = sealPassword.length >= MIN_PASSWORD;
		const filename = item.file.original_filename;
		const fileId = item.id;
		const result = await encryption.seal(
			fileId,
			usePassword ? sealPassword : undefined,
		);
		setSealPassword("");
		if (!result) return;
		// Close first: the reveal must be the only thing on screen, and the sheet
		// is about to re-render against a row this mutation just changed.
		onOpenChange(false);
		reveal({
			subject: `“${filename}”`,
			key: result.key,
			isPassword: result.key_is_password,
			reason: "the server encrypted it once and then discarded the key.",
			refs: [{ kind: "file", id: fileId }],
		});
	};

	/** One key for every plaintext/server-side file directly in this folder. */
	const convertFolderToE2E = async () => {
		if (!isFolder || !children.data) return;
		const targets = children.data.files.filter(
			(f) => f.encryption_mode === "none" || f.encryption_mode === "server",
		);
		if (!targets.length) return;
		const key = randomKey();
		const folderTitle = item.dir.title;
		setBatch({ done: 0, total: targets.length });
		let converted = 0;
		let leftovers = 0;
		const refs: KeyRef[] = [];
		for (let i = 0; i < targets.length; i++) {
			setBatch({ done: i, total: targets.length });
			const result = await conversion.convert({
				file: targets[i],
				target: "client",
				presetKey: key,
			});
			// A null result means nothing was uploaded, so this key opens nothing
			// new. A non-null one with `committed: false` means the ciphertext is
			// on the server under this key and the original is still there too.
			if (!result) continue;
			converted += 1;
			refs.push({ kind: "file", id: result.newFileId });
			if (!result.committed) leftovers += 1;
		}
		setBatch(null);
		// Revealing a key that opens nothing — and making the user type it back to
		// dismiss the dialog — would be a lie about what just happened.
		if (!converted) return;
		onOpenChange(false);
		reveal({
			subject:
				`${converted} file${converted === 1 ? "" : "s"} in “${folderTitle}”` +
				(leftovers
					? ` (${leftovers} original${leftovers === 1 ? "" : "s"} still to delete)`
					: ""),
			key: bytesToBase64Url(key),
			isPassword: false,
			reason:
				"they were re-encrypted in your browser and the key never reached the server.",
			incomplete: leftovers > 0,
			refs,
		});
	};

	const busy = encryption.busy || conversion.busy || batch !== null;

	return (
		<>
			<Sheet open={open} onOpenChange={onOpenChange}>
				<SheetContent className="w-full overflow-y-auto sm:max-w-md">
					<SheetTitle className="flex items-center gap-2">
						<Lock className="size-4" /> Encryption
					</SheetTitle>
					<SheetDescription className="break-words">
						{itemName(item)}
					</SheetDescription>

					<div className="mt-5 space-y-4">
						{/* ── where the key actually lives ───────────────────────── */}
						<div className="space-y-2 rounded-lg border border-border bg-secondary/20 p-3">
							<div className="flex items-center gap-2">
								{mode === "none" ? (
									<span className="text-sm font-medium">Not encrypted</span>
								) : (
									<>
										<EncryptionBadge mode={mode} inherited={!overridden} />
										<span className="text-sm font-medium">
											{mode === "server"
												? "Server-side encrypted"
												: mode === "client"
													? "End-to-end encrypted"
													: "Sealed"}
										</span>
									</>
								)}
							</div>
							<p className="text-xs text-muted-foreground">
								{overridden ? (
									"Holds its own key. Nothing above it can change what protects it."
								) : inheritedFrom ? (
									<>
										Inherited — the key lives on{" "}
										<Link
											to={drivePath(inheritedFrom)}
											onClick={() => onOpenChange(false)}
											className="font-medium text-primary underline-offset-2 hover:underline"
										>
											the folder above
										</Link>
										. Changing it there changes this too.
									</>
								) : (
									"Inherited from the folder above."
								)}
							</p>
							{mode === "server" && accessKey && (
								<div className="space-y-1">
									<span className="text-xs font-medium text-muted-foreground">
										Access key ({passwordLocked ? "password" : "random token"})
									</span>
									<div className="flex items-center gap-2 rounded-md border border-border bg-background/40 px-2.5 py-1.5">
										<code className="flex-1 truncate font-mono text-xs">
											{passwordLocked ? "•".repeat(12) : accessKey}
										</code>
										<CopyButton value={accessKey} />
									</div>
								</div>
							)}
						</div>

						{/* ── none <-> server, freely, either direction ──────────── */}
						{serverManaged ? (
							<Section
								title="Change encryption"
								hint={
									isFolder
										? "Everything below this folder that follows its key is re-encrypted. A large folder makes for a slow request."
										: undefined
								}
							>
								<Select
									value={nextMode}
									onValueChange={(v) => setNextMode(v as typeof nextMode)}
								>
									<SelectTrigger>
										<SelectValue />
									</SelectTrigger>
									<SelectContent>
										<SelectItem value="none">
											None — the link is the credential
										</SelectItem>
										<SelectItem value="server">
											Server-side — a ?ek= key gates downloads
										</SelectItem>
										{canAdopt && (
											<SelectItem value="inherit">
												Follow the folder above
											</SelectItem>
										)}
									</SelectContent>
								</Select>
								{nextMode === "server" && (
									<div className="space-y-1.5">
										<Label htmlFor="mode-password" className="text-xs">
											Password instead of a random key (optional)
										</Label>
										<Input
											id="mode-password"
											type="password"
											placeholder={`At least ${MIN_PASSWORD} characters`}
											value={modePassword}
											onChange={(e) => setModePassword(e.target.value)}
										/>
									</div>
								)}
								<Button
									className="w-full"
									loading={busy}
									onClick={applyMode}
									disabled={
										nextMode === "server" &&
										modePassword.length > 0 &&
										modePassword.length < MIN_PASSWORD
									}
								>
									Apply
								</Button>
							</Section>
						) : (
							<Section title="Change encryption">
								<p className="flex items-start gap-2 rounded-md border border-warning/30 bg-warning/10 px-3 py-2 text-xs text-warning">
									<ShieldAlert className="mt-0.5 size-4 shrink-0" />
									<span>
										The server holds no key for this, so it cannot re-encrypt
										it. Converting means decrypting in your browser and
										uploading it again — see below.
									</span>
								</p>
							</Section>
						)}

						{/* ── the ?ek= secret, swapped without touching the bytes ── */}
						{mode === "server" && overridden && (
							<Section
								title="Access key"
								hint="Changing the secret doesn't re-encrypt anything, and it resets the guess counter on every link. A password-locked link is rate-limited per slug; a random token isn't, because 144 bits isn't a guessing target."
							>
								<div className="flex gap-2">
									<Input
										type="password"
										placeholder={`New password (min ${MIN_PASSWORD})`}
										value={accessPassword}
										onChange={(e) => setAccessPassword(e.target.value)}
									/>
									<Button
										variant="outline"
										loading={busy}
										disabled={accessPassword.length < MIN_PASSWORD}
										onClick={async () => {
											await encryption.setAccessSecret(item, accessPassword);
											setAccessPassword("");
										}}
									>
										<Lock /> Lock
									</Button>
								</div>
								<Button
									variant="ghost"
									size="sm"
									loading={busy}
									onClick={() => encryption.setAccessSecret(item)}
								>
									<Link2Off /> Issue a fresh random key instead
								</Button>
							</Section>
						)}

						{/* ── Seal & Forget ──────────────────────────────────────── */}
						{!isFolder && serverManaged && (
							<Section
								title="Seal & Forget"
								hint="Encrypts this file with a key returned to you once and stored nowhere. Honest difference from true end-to-end: the key passes through this server's memory for that one operation. It never touches disk or logs, but end-to-end also resists an attacker who controls the server at that exact moment, and this doesn't."
							>
								{canSeal ? (
									<>
										<Input
											type="password"
											placeholder={`Optional password (min ${MIN_PASSWORD}) — otherwise a random key`}
											value={sealPassword}
											onChange={(e) => setSealPassword(e.target.value)}
										/>
										{!sealPasswordOk && (
											<p className="text-xs text-destructive">
												Use at least {MIN_PASSWORD} characters, or leave this
												empty for a random key. A shorter password is ignored.
											</p>
										)}
										<Button
											variant="outline"
											className="w-full"
											loading={busy}
											disabled={!sealPasswordOk}
											onClick={doSeal}
										>
											<ShieldCheck /> Seal this file
										</Button>
									</>
								) : (
									<p className="flex items-start gap-2 rounded-md border border-border bg-secondary/20 px-3 py-2 text-xs text-muted-foreground">
										<Info className="mt-0.5 size-3.5 shrink-0" />
										<span>
											{isOwner
												? "Sealing is irreversible and leaves the file unreadable even to you, so it needs the delete permission — which this account doesn't have."
												: "Only the file's owner can seal it. Being an editor of the folder isn't enough."}
										</span>
									</p>
								)}
							</Section>
						)}

						{/* ── end-to-end, which only the browser can do ──────────── */}
						<Section
							title="End-to-end"
							hint={
								isFolder
									? "A folder's own end-to-end mode is fixed when it's created, so this converts the files directly inside it instead — one key for the whole batch, shown once."
									: "The bytes come down, change in your browser, and go back up as a new file. The old one is deleted only once the replacement is confirmed."
							}
						>
							{isFolder ? (
								<>
									<Button
										variant="outline"
										className="w-full"
										loading={busy}
										disabled={
											!children.data?.files.some(
												(f) =>
													f.encryption_mode === "none" ||
													f.encryption_mode === "server",
											)
										}
										onClick={convertFolderToE2E}
									>
										<ShieldAlert /> Convert files in this folder
									</Button>
									{batch && (
										<p className="text-xs text-muted-foreground">
											Converting {batch.done + 1} of {batch.total}
											{conversion.progress
												? ` · ${conversion.progress.phase} ${conversion.progress.percent}%`
												: ""}
										</p>
									)}
								</>
							) : (
								<Button
									variant="outline"
									className="w-full"
									onClick={() => setConvertOpen(true)}
								>
									{serverManaged ? (
										<>
											<ShieldAlert /> Convert to end-to-end
										</>
									) : (
										<>
											<CornerLeftUp /> Decrypt permanently
										</>
									)}
								</Button>
							)}
						</Section>

						<p className="flex items-start gap-2 pt-2 text-xs text-muted-foreground">
							<Info className="mt-0.5 size-3.5 shrink-0" />
							<span>
								Moving something never changes its key — whatever is already
								encrypted stays under the key it has now.
							</span>
						</p>
					</div>
				</SheetContent>
			</Sheet>

			{item.kind === "file" && (
				<E2EConvertDialog
					file={item.file}
					open={convertOpen}
					onOpenChange={setConvertOpen}
					onConverted={() => onOpenChange(false)}
				/>
			)}
		</>
	);
}
