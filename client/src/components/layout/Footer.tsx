import { useState } from "react";
import { replayAvailable, uploadReplay } from "@/lib/sentry";

const REPO = "https://github.com/TinnyTerr/file-upload";
const COOLDOWN_MS = 60_000;

// `fileupload@<version>[+<sha>]`
const [version = "", sha = ""] = __SENTRY_RELEASE__
	.replace(/^fileupload@/, "")
	.split("+");

let lastUpload = 0;

type ReplayState = "idle" | "sending" | "sent" | "failed";

/** Copyright, licence, links, build, and a manual "send my replay" action. */
export function Footer() {
	const [state, setState] = useState<ReplayState>("idle");
	const [replayId, setReplayId] = useState<string | null>(null);

	const send = async () => {
		if (state === "sending") return;
		if (Date.now() - lastUpload < COOLDOWN_MS) return;
		lastUpload = Date.now();
		setState("sending");
		try {
			const id = await uploadReplay();
			setReplayId(id);
			setState(id ? "sent" : "failed");
		} catch {
			setState("failed");
		}
	};

	const link =
		"underline-offset-2 hover:text-foreground hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring rounded-sm";

	return (
		<footer className="flex flex-col items-center gap-1.5 px-4 py-6 text-center text-xs text-muted-foreground">
			<p className="flex flex-wrap justify-center gap-x-2 gap-y-1">
				<span>© {new Date().getFullYear()} TinnyTerr</span>
				<span aria-hidden>·</span>
				<span>GPL-3.0-only</span>
				{__PORTFOLIO_URL__ && (
					<>
						<span aria-hidden>·</span>
						<a
							href={__PORTFOLIO_URL__}
							target="_blank"
							rel="noreferrer"
							className={link}
						>
							Portfolio
						</a>
					</>
				)}
				<span aria-hidden>·</span>
				<a href={REPO} target="_blank" rel="noreferrer" className={link}>
					Source
				</a>
			</p>
			<p className="flex flex-wrap justify-center gap-x-2 gap-y-1">
				<span>Oxymoron (for files)</span>
				{version && (
					<>
						<span aria-hidden>·</span>
						<a
							href={`${REPO}/releases/tag/v${version}`}
							target="_blank"
							rel="noreferrer"
							className={link}
						>
							v{version}
						</a>
						{sha && (
							<a
								href={`${REPO}/commit/${sha}`}
								target="_blank"
								rel="noreferrer"
								className={`font-mono ${link}`}
							>
								{sha}
							</a>
						)}
					</>
				)}
				{replayAvailable && (
					<>
						<span aria-hidden>·</span>
						<button
							type="button"
							onClick={send}
							disabled={state === "sending"}
							className={`${link} disabled:opacity-60`}
							title="Uploads the last minute of this session (text and media masked) for debugging"
						>
							{state === "sending"
								? "Uploading…"
								: state === "sent"
									? `Replay sent${replayId ? ` (${replayId.slice(0, 8)})` : ""}`
									: state === "failed"
										? "Replay failed, retry"
										: "Upload replay"}
						</button>
					</>
				)}
			</p>
		</footer>
	);
}
