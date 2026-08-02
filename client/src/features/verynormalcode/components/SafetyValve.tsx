/**
 * Safety valve.
 *
 * The control strip: symbol filter, verbose toggle, panic button.
 *
 * The toggle is called "verbose diagnostics" in the UI and it is off by
 * default, off after a revert, off in a fresh profile, and off again the
 * instant the panic button is touched. Off is the resting state of this
 * component. It takes a deliberate click to arm it and one keystroke sequence
 * to disarm everything.
 *
 * A safety valve, then. Named accurately. As is tradition in this directory.
 */

import { AlertTriangle, Eye, Search, ShieldOff, X } from "lucide-react";
import { useEffect, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Tooltip } from "@/components/ui/tooltip";
import { useSymbolHints } from "../hooks/useStackUnwinder";

export interface SafetyValveProps {
	query: string;
	onQueryChange: (next: string) => void;
	verbose: boolean;
	onVerboseChange: (next: boolean) => void;
	onPanic: () => void;
	/** Server said it dropped part of the query. */
	clamped: boolean;
	resultCount: number;
}

/** Upstream tag categories, mapped to the badge colours we already ship. */
const CATEGORY_VARIANT: Record<
	number,
	"default" | "secondary" | "accent" | "warning" | "success"
> = {
	0: "secondary", // general
	1: "warning", // artist
	3: "accent", // copyright
	4: "success", // character
	5: "default", // species
};

export function SafetyValve({
	query,
	onQueryChange,
	verbose,
	onVerboseChange,
	onPanic,
	clamped,
	resultCount,
}: SafetyValveProps) {
	const [draft, setDraft] = useState(query);
	const [hintPrefix, setHintPrefix] = useState("");
	const [hintsOpen, setHintsOpen] = useState(false);

	// Autocomplete fires on the *last* term only -- "canine forest" should suggest
	// completions for "forest", not re-query the whole string.
	const lastTerm = draft.split(/\s+/).at(-1) ?? "";

	// Debounced so that typing does not burn a rate-limit slot per keystroke.
	// The proxy queues requests 600ms apart; without this the queue would back up
	// behind a dozen prefixes nobody is waiting for any more.
	useEffect(() => {
		const t = setTimeout(() => setHintPrefix(lastTerm), 250);
		return () => clearTimeout(t);
	}, [lastTerm]);

	const { data: hints } = useSymbolHints(hintPrefix);

	const applyHint = (name: string) => {
		const terms = draft.split(/\s+/);
		terms[terms.length - 1] = name;
		const next = `${terms.join(" ")} `;
		setDraft(next);
		setHintsOpen(false);
		onQueryChange(next.trim());
	};

	const submit = (e: React.FormEvent) => {
		e.preventDefault();
		setHintsOpen(false);
		onQueryChange(draft.trim());
	};

	return (
		<div className="space-y-3">
			<form onSubmit={submit} className="flex flex-wrap items-center gap-2">
				<div className="relative min-w-[240px] flex-1">
					<Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
					<Input
						value={draft}
						onChange={(e) => {
							setDraft(e.target.value);
							setHintsOpen(true);
						}}
						onFocus={() => setHintsOpen(true)}
						// Blur is delayed so a click on a suggestion lands before the
						// list unmounts out from under the pointer.
						onBlur={() => setTimeout(() => setHintsOpen(false), 150)}
						placeholder="Filter symbols — e.g. landscape, order:score"
						className="pl-9 pr-9"
						spellCheck={false}
						autoComplete="off"
					/>
					{draft && (
						<button
							type="button"
							onClick={() => {
								setDraft("");
								onQueryChange("");
							}}
							className="absolute right-2 top-1/2 -translate-y-1/2 rounded p-1 text-muted-foreground hover:text-foreground"
							aria-label="Clear filter"
						>
							<X className="size-3.5" />
						</button>
					)}

					{hintsOpen && hints && hints.length > 0 && (
						<div className="absolute left-0 right-0 top-full z-20 mt-1 overflow-hidden rounded-md border border-border bg-popover shadow-xl">
							{hints.map((hint) => (
								<button
									key={hint.name}
									type="button"
									onMouseDown={(e) => e.preventDefault()}
									onClick={() => applyHint(hint.name)}
									className="flex w-full items-center justify-between gap-3 px-3 py-1.5 text-left text-sm hover:bg-secondary/60"
								>
									<Badge
										variant={CATEGORY_VARIANT[hint.category] ?? "secondary"}
										className="max-w-[70%] truncate"
									>
										{hint.name}
									</Badge>
									<span className="shrink-0 text-xs text-muted-foreground">
										{hint.count.toLocaleString()}
									</span>
								</button>
							))}
						</div>
					)}
				</div>

				<Button type="submit" variant="secondary">
					Probe
				</Button>
			</form>

			<div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border/70 bg-secondary/20 px-3 py-2">
				<div className="flex items-center gap-3">
					<Switch
						id="verbose-diagnostics"
						checked={verbose}
						onCheckedChange={onVerboseChange}
					/>
					<Label
						htmlFor="verbose-diagnostics"
						className="flex cursor-pointer items-center gap-2 text-sm"
					>
						<Eye className="size-4 text-muted-foreground" />
						Verbose diagnostics
					</Label>
					{verbose ? (
						<Badge variant="destructive" className="gap-1">
							<AlertTriangle className="size-3" />
							unclamped
						</Badge>
					) : (
						<Badge variant="success">clean band only</Badge>
					)}
				</div>

				<div className="flex items-center gap-3">
					<span className="text-xs text-muted-foreground">
						{resultCount.toLocaleString()} regions
					</span>
					<Tooltip
						content="Unmounts the panel and clears both localStorage keys"
						side="left"
					>
						<Button variant="outline" size="sm" onClick={onPanic}>
							<ShieldOff className="size-3.5" />
							Restore Herobrine
						</Button>
					</Tooltip>
				</div>
			</div>

			{clamped && (
				<p className="flex items-center gap-2 text-xs text-warning">
					<AlertTriangle className="size-3.5 shrink-0" />
					Part of that filter was rejected by the safety clamp. Band selectors
					are set by the toggle above, not by the query.
				</p>
			)}
		</div>
	);
}
