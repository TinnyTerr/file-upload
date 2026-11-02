import {
	ChevronDown,
	ChevronRight,
	ExternalLink,
	Folder,
	Inbox,
	KeyRound,
	Link2,
	Pause,
	Play,
	Trash2,
} from "lucide-react";
import { useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { CopyButton } from "@/components/ui/copy-button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { FolderPicker } from "@/features/drive/components/FolderPicker";
import { formatBytes } from "@/lib/bytes";
import { formatDateTime, relativeTime } from "@/lib/time";
import {
	useDropboxReceived,
	usePersistentDropboxes,
} from "../hooks/usePersistentDropboxes";
import { type DropboxSummary, withPassword } from "../services/dropboxService";

/** Persistent, password-guarded dropboxes: any number at once, each with its
 * own destination folder and a running record of what it received. */
export function PersistentDropboxes() {
	const { list, create, update, remove } = usePersistentDropboxes();
	const [name, setName] = useState("");
	const [password, setPassword] = useState("");
	const [directoryId, setDirectoryId] = useState<number | null>(null);

	const submit = () =>
		create.mutate(
			{
				unlimited: true,
				name: name.trim() || undefined,
				password,
				target_directory_id: directoryId,
			},
			{
				onSuccess: () => {
					setName("");
					setPassword("");
				},
			},
		);

	const boxes = (list.data ?? []).filter((b) => b.unlimited);

	return (
		<div className="space-y-5">
			<div className="space-y-3 rounded-lg border border-border bg-secondary/20 p-4">
				<p className="text-xs text-muted-foreground">
					A persistent dropbox never expires and takes any number of files, from
					anyone with the link and password. Your quota still applies.
				</p>
				<div className="grid gap-3 sm:grid-cols-2">
					<div className="space-y-1.5">
						<Label htmlFor="pdb-name">Name</Label>
						<Input
							id="pdb-name"
							placeholder="Client uploads"
							maxLength={80}
							value={name}
							onChange={(e) => setName(e.target.value)}
						/>
					</div>
					<div className="space-y-1.5">
						<Label htmlFor="pdb-pw">Password</Label>
						<Input
							id="pdb-pw"
							type="password"
							autoComplete="new-password"
							placeholder="8+ characters"
							value={password}
							onChange={(e) => setPassword(e.target.value)}
						/>
					</div>
				</div>
				<div className="space-y-1.5">
					<Label>Destination</Label>
					<FolderPicker
						rootLabel="My Drive — no folder"
						veto={(d) =>
							d.encryption_mode === "client" || d.encryption_mode === "sealed"
								? "end-to-end"
								: null
						}
						className="max-h-44"
						value={directoryId}
						onChange={setDirectoryId}
					/>
				</div>
				<Button
					className="w-full"
					loading={create.isPending}
					disabled={password.length < 8}
					onClick={submit}
				>
					<Inbox /> Create dropbox
				</Button>
			</div>

			{boxes.length === 0 ? (
				<p className="text-center text-sm text-muted-foreground">
					No persistent dropboxes yet.
				</p>
			) : (
				<div className="space-y-2">
					{boxes.map((box) => (
						<BoxRow
							key={box.id}
							box={box}
							onToggle={() =>
								update.mutate({ id: box.id, body: { active: !box.active } })
							}
							onPassword={(pw) =>
								update.mutate(
									{ id: box.id, body: { password: pw } },
									{ onSuccess: () => undefined },
								)
							}
							onDelete={() => {
								if (
									window.confirm(
										`Delete "${box.name || "this dropbox"}"? Its link stops working and its receive log is removed. Files already received are kept.`,
									)
								)
									remove.mutate(box.id);
							}}
						/>
					))}
				</div>
			)}
		</div>
	);
}

function BoxRow({
	box,
	onToggle,
	onPassword,
	onDelete,
}: {
	box: DropboxSummary;
	onToggle: () => void;
	onPassword: (pw: string) => void;
	onDelete: () => void;
}) {
	const [open, setOpen] = useState(false);
	const [newPw, setNewPw] = useState<string | null>(null);
	const [linkPw, setLinkPw] = useState<string | null>(null);
	const received = useDropboxReceived(box.id, open);

	return (
		<div className="rounded-lg border border-border bg-secondary/10">
			<div className="flex flex-wrap items-center gap-2 p-3">
				<button
					type="button"
					className="flex min-w-0 flex-1 items-center gap-2 text-left"
					onClick={() => setOpen((o) => !o)}
				>
					{open ? (
						<ChevronDown className="size-4 shrink-0" />
					) : (
						<ChevronRight className="size-4 shrink-0" />
					)}
					<span className="min-w-0">
						<span className="flex items-center gap-2">
							<span className="truncate text-sm font-medium">
								{box.name || `Dropbox #${box.id}`}
							</span>
							{!box.active && <Badge variant="secondary">Paused</Badge>}
						</span>
						<span className="flex flex-wrap items-center gap-x-3 text-xs text-muted-foreground">
							<span className="flex items-center gap-1">
								<Folder className="size-3" />
								{box.target_directory_title ?? "My Drive"}
							</span>
							<span>
								{box.upload_count} file{box.upload_count === 1 ? "" : "s"} ·{" "}
								{formatBytes(box.bytes_received)}
							</span>
							<span>
								{box.last_used_at
									? `last ${relativeTime(box.last_used_at)}`
									: "nothing received yet"}
							</span>
						</span>
					</span>
				</button>
				<div className="flex items-center gap-1">
					{box.url && <CopyButton value={box.url} />}
					{box.url && (
						<Button variant="ghost" size="sm" asChild>
							<a href={box.url} target="_blank" rel="noreferrer">
								<ExternalLink />
							</a>
						</Button>
					)}
					<Button
						variant="ghost"
						size="sm"
						title={box.active ? "Pause" : "Resume"}
						onClick={onToggle}
					>
						{box.active ? <Pause /> : <Play />}
					</Button>
					{box.url && box.has_password && (
						<Button
							variant="ghost"
							size="sm"
							title="Link with password included"
							onClick={() => setLinkPw(linkPw === null ? "" : null)}
						>
							<Link2 />
						</Button>
					)}
					<Button
						variant="ghost"
						size="sm"
						title="Change password"
						onClick={() => setNewPw(newPw === null ? "" : null)}
					>
						<KeyRound />
					</Button>
					<Button
						variant="ghost"
						size="sm"
						className="text-destructive"
						title="Delete"
						onClick={onDelete}
					>
						<Trash2 />
					</Button>
				</div>
			</div>

			{linkPw !== null && box.url && (
				<div className="space-y-2 border-t border-border p-3">
					<div className="flex gap-2">
						<Input
							type="password"
							autoComplete="off"
							placeholder="This dropbox's password"
							value={linkPw}
							onChange={(e) => setLinkPw(e.target.value)}
						/>
						{linkPw && <CopyButton value={withPassword(box.url, linkPw)} />}
					</div>
					<p className="text-xs text-muted-foreground">
						The password goes after the # in the link, so it's never sent to the
						server. Anyone holding the link can upload without typing it. We
						don't store the password, so type it to build the link.
					</p>
				</div>
			)}

			{newPw !== null && (
				<div className="flex gap-2 border-t border-border p-3">
					<Input
						type="password"
						autoComplete="new-password"
						placeholder="New password (8+ characters)"
						value={newPw}
						onChange={(e) => setNewPw(e.target.value)}
					/>
					<Button
						disabled={newPw.length < 8}
						onClick={() => {
							onPassword(newPw);
							setNewPw(null);
						}}
					>
						Save
					</Button>
				</div>
			)}

			{open && (
				<div className="border-t border-border p-3">
					{received.isLoading ? (
						<p className="text-xs text-muted-foreground">Loading…</p>
					) : !received.data?.length ? (
						<p className="text-xs text-muted-foreground">
							Nothing received yet.
						</p>
					) : (
						<ul className="space-y-1">
							{received.data.map((r) => (
								<li
									key={r.id}
									className="flex items-center justify-between gap-3 text-xs"
								>
									<span className="truncate">{r.original_filename}</span>
									<span className="shrink-0 text-muted-foreground">
										{formatBytes(r.size)} · {formatDateTime(r.created_at)}
										{r.ip ? ` · ${r.ip}` : ""}
									</span>
								</li>
							))}
						</ul>
					)}
				</div>
			)}
		</div>
	);
}
