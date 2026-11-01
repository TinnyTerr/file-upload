import { useQuery } from "@tanstack/react-query";
import {
	CheckCircle2,
	FileIcon,
	FileWarning,
	Inbox,
	UploadCloud,
} from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { Input } from "@/components/ui/input";
import { Progress } from "@/components/ui/progress";
import { Skeleton } from "@/components/ui/skeleton";
import { ApiError } from "@/config/api";
import { Dropzone } from "@/features/files/components/Dropzone";
import { formatBytes } from "@/lib/bytes";
import { dropboxService } from "../services/dropboxService";

const fileIds = new WeakMap<File, number>();
let nextFileId = 0;
function fileKey(f: File): number {
	let id = fileIds.get(f);
	if (id === undefined) {
		id = nextFileId++;
		fileIds.set(f, id);
	}
	return id;
}

export function DropboxUploadPage({ token }: { token: string }) {
	const info = useQuery({
		queryKey: ["dropbox", token],
		queryFn: () => dropboxService.info(token),
		enabled: !!token,
		retry: false,
	});

	const [files, setFiles] = useState<File[]>([]);
	const [current, setCurrent] = useState(0);
	const [percent, setPercent] = useState(0);
	const [status, setStatus] = useState<"idle" | "uploading" | "done" | "error">(
		"idle",
	);
	const [phase, setPhase] = useState<"uploading" | "finalizing">("uploading");
	const [error, setError] = useState<string | null>(null);
	const [password, setPassword] = useState("");
	const [sent, setSent] = useState(0);

	// A one-time link is spent by its first file; only a persistent box takes a batch.
	const persistent = info.data?.unlimited ?? false;

	const upload = async () => {
		if (!files.length) return;
		setStatus("uploading");
		setPhase("uploading");
		setPercent(0);
		setError(null);
		// Sequential, resuming at the first unsent file after an error so a retry
		// doesn't re-send what already landed.
		let i = 0;
		try {
			for (; i < files.length; i++) {
				const file = files[i];
				setCurrent(i);
				setPercent(0);
				await dropboxService.upload(
					token,
					file,
					file.name,
					(progress) => {
						setPhase(progress.phase);
						setPercent(progress.percent);
					},
					password,
				);
				setSent((n) => n + 1);
			}
			setStatus("done");
		} catch (err) {
			setFiles((fs) => fs.slice(i));
			setCurrent(0);
			setError(err instanceof Error ? err.message : "Upload failed");
			setStatus("error");
		}
	};

	if (info.isLoading) {
		return (
			<Card>
				<CardContent className="space-y-4 p-6">
					<Skeleton className="h-8 w-1/2" />
					<Skeleton className="h-32 w-full" />
				</CardContent>
			</Card>
		);
	}

	// 404/410 → link never existed, already used, or expired.
	if (info.isError) {
		const gone = info.error instanceof ApiError && info.error.status === 410;
		return (
			<EmptyState
				icon={FileWarning}
				title={
					gone
						? "This link has already been used or expired"
						: "Receive link not found"
				}
				description="Ask the recipient to send you a new link."
			/>
		);
	}

	const again = () => {
		setFiles([]);
		setCurrent(0);
		setPercent(0);
		setStatus("idle");
	};

	if (status === "done") {
		return (
			<Card>
				<CardContent className="flex flex-col items-center gap-3 p-10 text-center">
					<div className="flex size-14 items-center justify-center rounded-2xl bg-success/15">
						<CheckCircle2 className="size-7 text-success" />
					</div>
					<h1 className="break-words text-xl font-bold">
						{sent > 1 ? "Files sent" : "File sent"}
					</h1>
					<p className="max-w-sm text-sm text-muted-foreground">
						{persistent
							? `Your file was uploaded successfully (${sent} sent so far).`
							: "Your file was uploaded successfully. This one-time link is now closed."}
					</p>
					{persistent && (
						<Button variant="secondary" onClick={again}>
							Send another
						</Button>
					)}
				</CardContent>
			</Card>
		);
	}

	return (
		<Card>
			<CardContent className="space-y-5 p-6">
				<div className="flex items-center gap-3">
					<div className="flex size-12 items-center justify-center rounded-xl bg-brand-gradient shadow-lg shadow-primary/20">
						<Inbox className="size-6 text-white" />
					</div>
					<div>
						<h1 className="break-words text-xl font-bold">
							{info.data?.name || "Send a file"}
						</h1>
						<p className="text-sm text-muted-foreground">
							{persistent
								? "Upload files to the person who shared this dropbox."
								: "Upload one file to the person who shared this link."}
						</p>
					</div>
				</div>

				{!files.length ? (
					<Dropzone
						multiple={persistent}
						onFiles={(fs) => setFiles(persistent ? fs : fs.slice(0, 1))}
						hint={persistent ? undefined : "One file only"}
					/>
				) : (
					<div className="space-y-2">
						{files.map((f, i) => (
							<div
								key={fileKey(f)}
								className="flex items-center justify-between gap-2 rounded-lg border border-border bg-secondary/20 px-3 py-2.5"
							>
								<span className="flex min-w-0 items-center gap-2">
									<FileIcon className="size-4 shrink-0 text-muted-foreground" />
									<span className="truncate text-sm">{f.name}</span>
								</span>
								<span className="flex items-center gap-2 text-xs text-muted-foreground">
									{formatBytes(f.size)}
									{status !== "uploading" && (
										<Button
											variant="ghost"
											size="sm"
											onClick={() =>
												setFiles((fs) => fs.filter((_, j) => j !== i))
											}
										>
											Remove
										</Button>
									)}
								</span>
							</div>
						))}
					</div>
				)}

				{info.data?.password_required && (
					<Input
						type="password"
						placeholder="Dropbox password"
						autoComplete="off"
						value={password}
						onChange={(e) => setPassword(e.target.value)}
						disabled={status === "uploading"}
					/>
				)}

				{status === "uploading" && <Progress value={percent} />}
				{error && <p className="text-sm text-destructive">{error}</p>}

				<Button
					className="w-full"
					size="lg"
					disabled={
						!files.length ||
						status === "uploading" ||
						(!!info.data?.password_required && !password)
					}
					loading={status === "uploading"}
					onClick={upload}
				>
					<UploadCloud />{" "}
					{status === "uploading"
						? phase === "finalizing"
							? "Finalizing…"
							: `Uploading${files.length > 1 ? ` ${current + 1}/${files.length}` : ""}… ${percent}%`
						: files.length > 1
							? `Upload ${files.length} files`
							: "Upload file"}
				</Button>
			</CardContent>
		</Card>
	);
}
