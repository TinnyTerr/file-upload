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
import type { UseBulk } from "../hooks/useBulk";
import type { BulkPreview } from "../types";

/** Shared preview → type-to-confirm dialog driven by a useBulk() instance. */
export function BulkConfirmDialog({ bulk }: { bulk: UseBulk }) {
	const { preview, confirm, cancel, running } = bulk;

	return (
		<Dialog open={!!preview} onOpenChange={(o) => !o && cancel()}>
			<DialogContent className="max-w-md">
				{preview && (
					// Keyed on the previewed action, so a new preview always gets an
					// empty confirmation field rather than the previous one's text.
					<BulkConfirmBody
						key={`${preview.action}:${preview.data.confirmation_phrase}`}
						preview={preview.data}
						running={running}
						onConfirm={confirm}
						onCancel={cancel}
					/>
				)}
			</DialogContent>
		</Dialog>
	);
}

function BulkConfirmBody({
	preview,
	running,
	onConfirm,
	onCancel,
}: {
	preview: BulkPreview;
	running: boolean;
	onConfirm: () => void;
	onCancel: () => void;
}) {
	const [typed, setTyped] = useState("");
	const phraseOk = typed.trim() === preview.confirmation_phrase;

	return (
		<>
			<DialogHeader>
				<DialogTitle>Confirm bulk action</DialogTitle>
				<DialogDescription>
					This will affect <strong>{preview.affected_count}</strong> record(s)
					and cannot be undone.
				</DialogDescription>
			</DialogHeader>

			{preview.items.length > 0 && (
				<div className="max-h-48 space-y-1 overflow-y-auto rounded-md border border-border bg-background/40 p-2 text-xs">
					{preview.items.map((it) => (
						<div
							key={it.id}
							className="truncate font-mono text-muted-foreground"
						>
							{it.label}
						</div>
					))}
				</div>
			)}

			<div className="space-y-1.5">
				<p className="text-sm text-muted-foreground">
					Type{" "}
					<code className="rounded bg-secondary px-1 font-mono">
						{preview.confirmation_phrase}
					</code>{" "}
					to confirm.
				</p>
				<Input
					value={typed}
					onChange={(e) => setTyped(e.target.value)}
					placeholder={preview.confirmation_phrase}
					autoFocus
				/>
			</div>

			<DialogFooter>
				<Button variant="ghost" onClick={onCancel}>
					Cancel
				</Button>
				<Button
					variant="destructive"
					disabled={!phraseOk}
					loading={running}
					onClick={onConfirm}
				>
					Run action
				</Button>
			</DialogFooter>
		</>
	);
}
