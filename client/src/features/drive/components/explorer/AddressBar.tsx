import {
	ArrowLeft,
	ArrowRight,
	ArrowUp,
	ChevronRight,
	HardDrive,
	MoreHorizontal,
	RotateCw,
	Search,
	X,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Tooltip } from "@/components/ui/tooltip";
import { cn } from "@/lib/cn";
import { useDropTarget } from "../../hooks/useDropTarget";
import { useExplorer } from "../../hooks/useExplorer";
import { useNavHistory } from "../../hooks/useNavHistory";
import { drivePath } from "../../types";

/** Past this many segments the middle collapses into a "…" menu, the way
 * Explorer's address bar does. */
const MAX_VISIBLE = 3;

function Crumb({
	id,
	title,
	current,
}: {
	id: number | null;
	title: string;
	current: boolean;
}) {
	const navigate = useNavigate();
	// Every segment is a move target: dragging a file up two levels shouldn't
	// require navigating there first. A crumb carries only `{id, title}`, so it
	// is a `parent` zone -- moves in, no uploads (see useDropTarget).
	const { active, dropProps } = useDropTarget({ kind: "parent", id });

	return (
		<button
			type="button"
			{...dropProps}
			onClick={() => navigate(drivePath(id ?? "root"))}
			aria-current={current ? "page" : undefined}
			className={cn(
				"flex min-w-0 shrink-0 items-center gap-1.5 rounded px-1.5 py-1 text-sm transition-colors",
				current
					? "font-medium text-foreground"
					: "text-muted-foreground hover:bg-secondary hover:text-foreground",
				active && "bg-primary/15 text-primary ring-1 ring-primary/40",
			)}
		>
			{id === null && <HardDrive className="size-3.5 shrink-0" />}
			<span className="max-w-[14rem] truncate">{title}</span>
		</button>
	);
}

/** ← → ↑ ⟳, the path, and search. */
export function AddressBar() {
	const navigate = useNavigate();
	const { data, search, setSearch, items, totalCount } = useExplorer();
	const { back, forward, refresh, canBack, canForward } = useNavHistory();
	const [editing, setEditing] = useState(false);
	const [draft, setDraft] = useState("");
	const searchRef = useRef<HTMLInputElement>(null);

	const trail = data?.breadcrumbs ?? [];
	const parentId = trail.length >= 2 ? trail[trail.length - 2]!.id : null;
	const atRoot = trail.length === 0;
	const upZone = useDropTarget({
		kind: "parent",
		id: atRoot ? null : parentId,
	});

	// Ctrl+F focuses the box; the key map dispatches through this event so the
	// listener doesn't need a ref into this component.
	useEffect(() => {
		const focus = () => searchRef.current?.focus();
		window.addEventListener("fu:focus-search", focus);
		return () => window.removeEventListener("fu:focus-search", focus);
	}, []);

	const path = atRoot ? "/" : `/${trail.map((c) => c.title).join("/")}`;

	const commitPath = () => {
		setEditing(false);
		const raw = draft.trim();
		if (!raw || raw === "/") {
			navigate(drivePath("root"));
			return;
		}
		// A bare number is a folder id -- what the URL itself uses, and the only
		// unambiguous way to reach a folder whose title is duplicated.
		const asId = Number(raw.replace(/^\/+/, ""));
		if (Number.isInteger(asId) && asId > 0) {
			navigate(drivePath(asId));
			return;
		}
		// Titles aren't unique and there is no path-resolution endpoint, so match
		// against the trail we already have rather than pretending to resolve.
		const wanted =
			raw
				.replace(/^\/+|\/+$/g, "")
				.split("/")
				.pop() ?? "";
		const hit = trail.find(
			(c) => c.title.toLowerCase() === wanted.toLowerCase(),
		);
		if (hit) navigate(drivePath(hit.id));
		else toast.error(`No folder named "${wanted}" in the current path.`);
	};

	const visible =
		trail.length > MAX_VISIBLE ? trail.slice(-MAX_VISIBLE) : trail;
	const overflow =
		trail.length > MAX_VISIBLE ? trail.slice(0, -MAX_VISIBLE) : [];

	return (
		<div className="flex items-center gap-1 border-b border-border px-2 py-1.5">
			<Tooltip content="Back (Alt+←)">
				<Button
					variant="ghost"
					size="icon"
					className="size-8"
					disabled={!canBack}
					onClick={back}
					aria-label="Back"
				>
					<ArrowLeft />
				</Button>
			</Tooltip>
			<Tooltip content="Forward (Alt+→)">
				<Button
					variant="ghost"
					size="icon"
					className="size-8"
					disabled={!canForward}
					onClick={forward}
					aria-label="Forward"
				>
					<ArrowRight />
				</Button>
			</Tooltip>
			<Tooltip content={atRoot ? "Already at the top" : "Up one level (Alt+↑)"}>
				<Button
					variant="ghost"
					size="icon"
					{...upZone.dropProps}
					className={cn(
						"size-8",
						upZone.active &&
							"bg-primary/15 text-primary ring-1 ring-primary/40",
					)}
					disabled={atRoot}
					onClick={() => navigate(drivePath(parentId ?? "root"))}
					aria-label="Up one level"
				>
					<ArrowUp />
				</Button>
			</Tooltip>
			<Tooltip content="Refresh (F5)">
				<Button
					variant="ghost"
					size="icon"
					className="size-8"
					onClick={refresh}
					aria-label="Refresh"
				>
					<RotateCw />
				</Button>
			</Tooltip>

			{/* ── the path ─────────────────────────────────────────────── */}
			{editing ? (
				<Input
					autoFocus
					value={draft}
					onChange={(e) => setDraft(e.target.value)}
					onBlur={commitPath}
					onKeyDown={(e) => {
						if (e.key === "Enter") commitPath();
						if (e.key === "Escape") setEditing(false);
					}}
					className="mx-1 h-8 flex-1"
					aria-label="Folder path"
				/>
			) : (
				<nav
					aria-label="Folder path"
					className="mx-1 flex min-w-0 flex-1 items-center gap-0.5 overflow-x-auto rounded px-1 py-0.5"
				>
					<Crumb id={null} title="My Drive" current={atRoot} />
					{overflow.length > 0 && (
						<>
							<ChevronRight className="size-3.5 shrink-0 text-muted-foreground" />
							<DropdownMenu>
								<DropdownMenuTrigger asChild>
									<Button
										variant="ghost"
										size="icon"
										className="size-6 shrink-0"
										aria-label="Show the folders in between"
									>
										<MoreHorizontal className="size-3.5" />
									</Button>
								</DropdownMenuTrigger>
								<DropdownMenuContent align="start">
									{overflow.map((c) => (
										<DropdownMenuItem
											key={c.id}
											onSelect={() => navigate(drivePath(c.id))}
										>
											{c.title}
										</DropdownMenuItem>
									))}
								</DropdownMenuContent>
							</DropdownMenu>
						</>
					)}
					{visible.map((c, i) => (
						<span key={c.id} className="flex min-w-0 items-center gap-0.5">
							<ChevronRight className="size-3.5 shrink-0 text-muted-foreground" />
							<Crumb
								id={c.id}
								title={c.title}
								current={i === visible.length - 1}
							/>
						</span>
					))}
					{/* The empty space after the last crumb turns the trail into a
					    text field, matching Explorer: click the path, type a path. */}
					<button
						type="button"
						onClick={() => {
							setDraft(path);
							setEditing(true);
						}}
						className="h-7 min-w-8 flex-1 rounded hover:bg-secondary/50"
						aria-label="Edit the folder path"
					/>
				</nav>
			)}

			{/* ── search ───────────────────────────────────────────────── */}
			<div className="relative w-52 shrink-0">
				<Search className="pointer-events-none absolute left-2 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
				<Input
					ref={searchRef}
					value={search}
					onChange={(e) => setSearch(e.target.value)}
					// Scope is named explicitly: this filters the open folder and
					// nothing below it, and a search box that doesn't say so reads as
					// broken the first time it misses a file two levels down.
					placeholder={`Search in ${data?.directory?.title ?? "My Drive"}`}
					className="h-8 pl-7 pr-7 text-xs"
					aria-label="Filter this folder by name"
				/>
				{search && (
					<button
						type="button"
						onClick={() => setSearch("")}
						className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
						aria-label="Clear the filter"
					>
						<X className="size-3.5" />
					</button>
				)}
			</div>
			{search && (
				<span className="shrink-0 text-xs text-muted-foreground">
					{items.length} of {totalCount}
				</span>
			)}
		</div>
	);
}
