import {
	ChevronDown,
	Globe,
	KeyRound,
	Lock,
	Plus,
	RotateCcw,
	Search,
	Trash2,
	User,
} from "lucide-react";
import { useMemo, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { EmptyState } from "@/components/ui/empty-state";
import { Input } from "@/components/ui/input";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { NewKeyModal } from "@/features/apikeys/components/NewKeyModal";
import { useApiKeys } from "@/features/apikeys/hooks/useApiKeys";
import type { AdminApiKey, NewApiKey } from "@/features/apikeys/types";
import { cn } from "@/lib/cn";
import { formatDate, relativeTime } from "@/lib/time";
import { useAdminKeys } from "../hooks/useAdminData";
import { useBulk } from "../hooks/useBulk";
import { useSelection } from "../hooks/useSelection";
import { BulkBar } from "./BulkBar";
import { BulkConfirmDialog } from "./BulkConfirmDialog";

type StatusFilter = "all" | "active" | "inactive" | "bound" | "unbound";

function UserSection({
	username,
	keys,
	selection,
}: {
	username: string;
	keys: AdminApiKey[];
	selection: ReturnType<typeof useSelection>;
}) {
	const [collapsed, setCollapsed] = useState(true);
	const allSelected = keys.every((k) => selection.has(k.id));
	const someSelected = keys.some((k) => selection.has(k.id));

	const toggleAll = () => {
		for (const k of keys) {
			if (selection.has(k.id) === allSelected) selection.toggle(k.id);
		}
	};

	return (
		<div className="rounded-lg border border-border bg-secondary/10">
			<div
				className="flex cursor-pointer items-center gap-3 px-3 py-2.5 hover:bg-secondary/20"
				onClick={() => setCollapsed((c) => !c)}
			>
				<Checkbox
					checked={allSelected ? true : someSelected ? "indeterminate" : false}
					onCheckedChange={toggleAll}
					onClick={(e) => e.stopPropagation()}
					aria-label={`Select all keys for ${username}`}
				/>
				<div className="flex size-7 shrink-0 items-center justify-center rounded-full bg-muted">
					<User className="size-3.5 text-muted-foreground" />
				</div>
				<span className="flex-1 text-sm font-semibold">{username}</span>
				<span className="text-xs text-muted-foreground">
					{keys.length} {keys.length === 1 ? "key" : "keys"}
				</span>
				<ChevronDown
					className={cn(
						"size-4 text-muted-foreground transition-transform",
						collapsed && "-rotate-90",
					)}
				/>
			</div>

			{!collapsed && (
				<div className="border-t border-border px-3 py-2 space-y-1.5">
					{keys.map((k) => (
						<div
							key={k.id}
							className={cn(
								"flex items-center gap-3 rounded-md border border-border bg-background/30 px-3 py-2",
								selection.has(k.id) && "ring-1 ring-primary/50",
							)}
						>
							<Checkbox
								checked={selection.has(k.id)}
								onCheckedChange={() => selection.toggle(k.id)}
								aria-label="Select key"
							/>
							<KeyRound className="size-4 shrink-0 text-muted-foreground" />
							<div className="min-w-0 flex-1">
								<div className="flex flex-wrap items-center gap-2">
									<span className="truncate text-sm font-medium">
										Key #{k.user_key_number}
									</span>
									{k.active ? (
										<Badge variant="success">active</Badge>
									) : (
										<Badge variant="secondary">inactive</Badge>
									)}
									{k.bound_ip ? (
										<Badge variant="accent">
											<Lock className="size-3" /> {k.bound_ip}
										</Badge>
									) : (
										<Badge variant="secondary">
											<Globe className="size-3" /> unbound
										</Badge>
									)}
								</div>
								<p className="text-xs text-muted-foreground">
									created {formatDate(k.created_at)} · last used{" "}
									{relativeTime(k.last_used_at)}
								</p>
							</div>
						</div>
					))}
				</div>
			)}
		</div>
	);
}

export function KeysTab() {
	const keys = useAdminKeys();
	const { create } = useApiKeys();
	const [filter, setFilter] = useState("");
	const [status, setStatus] = useState<StatusFilter>("all");
	const [newKey, setNewKey] = useState<NewApiKey | null>(null);
	const selection = useSelection();
	const bulk = useBulk(selection.clear);

	const grouped = useMemo(() => {
		const q = filter.trim().toLowerCase();
		const filtered = (keys.data ?? []).filter((k) => {
			if (
				q &&
				!k.owner_username.toLowerCase().includes(q) &&
				String(k.owner_id) !== q &&
				String(k.id) !== q
			)
				return false;
			if (status === "active" && !k.active) return false;
			if (status === "inactive" && k.active) return false;
			if (status === "bound" && !k.bound_ip) return false;
			if (status === "unbound" && k.bound_ip) return false;
			return true;
		});

		const map = new Map<string, AdminApiKey[]>();
		for (const k of filtered) {
			const u = k.owner_username;
			if (!map.has(u)) map.set(u, []);
			map.get(u)!.push(k);
		}
		return Array.from(map.entries()).sort(([a], [b]) => a.localeCompare(b));
	}, [keys.data, filter, status]);

	const onCreate = async () => setNewKey(await create.mutateAsync());

	return (
		<div className="space-y-4">
			<div className="flex flex-wrap items-center gap-2">
				<div className="relative min-w-48 flex-1">
					<Search className="absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
					<Input
						className="pl-8"
						placeholder="Filter by owner or id…"
						value={filter}
						onChange={(e) => setFilter(e.target.value)}
					/>
				</div>
				<Select
					value={status}
					onValueChange={(v) => setStatus(v as StatusFilter)}
				>
					<SelectTrigger className="w-36">
						<SelectValue />
					</SelectTrigger>
					<SelectContent>
						<SelectItem value="all">All</SelectItem>
						<SelectItem value="active">Active</SelectItem>
						<SelectItem value="inactive">Inactive</SelectItem>
						<SelectItem value="bound">Bound</SelectItem>
						<SelectItem value="unbound">Unbound</SelectItem>
					</SelectContent>
				</Select>
				<Button onClick={onCreate} loading={create.isPending}>
					<Plus /> New key
				</Button>
			</div>

			{keys.isLoading ? (
				<div className="space-y-2">
					<Skeleton className="h-16 w-full" />
					<Skeleton className="h-16 w-full" />
				</div>
			) : grouped.length === 0 ? (
				<EmptyState icon={KeyRound} title="No API keys" />
			) : (
				<div className="space-y-2 pb-16">
					{grouped.map(([username, userKeys]) => (
						<UserSection
							key={username}
							username={username}
							keys={userKeys}
							selection={selection}
						/>
					))}
				</div>
			)}

			<BulkBar count={selection.count} onClear={selection.clear}>
				<Button
					variant="ghost"
					size="sm"
					onClick={() => bulk.startPreview("reset_api_key_ips", selection.list)}
				>
					<RotateCcw /> Reset IP
				</Button>
				<Button
					variant="ghost"
					size="sm"
					className="text-destructive"
					onClick={() => bulk.startPreview("delete_api_keys", selection.list)}
				>
					<Trash2 /> Delete
				</Button>
			</BulkBar>
			<BulkConfirmDialog bulk={bulk} />
			<NewKeyModal apiKey={newKey} onClose={() => setNewKey(null)} />
		</div>
	);
}
