import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Plus, Send, Trash2 } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { CopyButton } from "@/components/ui/copy-button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { api, errorMessage } from "@/config/api";
import { formatDateTime } from "@/lib/time";
import { useDialogs } from "@/providers/DialogProvider";

interface Webhook {
	id: number;
	url: string;
	events: string[];
	active: boolean;
	format: string;
	created_at: string;
	last_triggered_at: string | null;
	last_status: number | null;
	/** Only present on the create response. */
	secret?: string;
}

interface WebhookList {
	webhooks: Webhook[];
	events: string[];
	formats: string[];
}

const KEY = ["webhooks"] as const;

const FORMAT_LABEL: Record<string, string> = {
	json: "JSON (signed)",
	discord: "Discord",
	ntfy: "ntfy",
};

const FORMAT_HINT: Record<string, string> = {
	json: "Machine-readable, with an X-Webhook-Signature HMAC header.",
	discord: "Paste a Discord channel webhook URL.",
	ntfy: "Paste the topic URL, e.g. https://ntfy.sh/your-topic.",
};

export function WebhooksTab() {
	const qc = useQueryClient();
	const { confirm } = useDialogs();
	const { data, isLoading } = useQuery({
		queryKey: KEY,
		queryFn: () => api.get<WebhookList>("/webhooks/"),
	});
	const [url, setUrl] = useState("");
	const [format, setFormat] = useState("json");
	const [events, setEvents] = useState<string[]>(["file.uploaded"]);
	/** The secret is shown once, straight after creation. */
	const [fresh, setFresh] = useState<Webhook | null>(null);

	const refresh = () => qc.invalidateQueries({ queryKey: KEY });

	const create = useMutation({
		mutationFn: () =>
			api.post<Webhook>("/webhooks/", { json: { url, format, events } }),
		onSuccess: (hook) => {
			setFresh(hook);
			setUrl("");
			refresh();
		},
		onError: (err) => toast.error(errorMessage(err)),
	});
	const toggle = useMutation({
		mutationFn: (h: Webhook) =>
			api.patch(`/webhooks/${h.id}`, { json: { active: !h.active } }),
		onSuccess: refresh,
		onError: (err) => toast.error(errorMessage(err)),
	});
	const test = useMutation({
		mutationFn: (id: number) => api.post(`/webhooks/${id}/test`),
		onSuccess: () => {
			toast.success("Test sent");
			refresh();
		},
		onError: (err) => toast.error(errorMessage(err)),
	});
	const remove = useMutation({
		mutationFn: (id: number) => api.delete(`/webhooks/${id}`),
		onSuccess: refresh,
		onError: (err) => toast.error(errorMessage(err)),
	});

	const onDelete = async (h: Webhook) => {
		const ok = await confirm({
			title: "Delete webhook?",
			description: h.url,
			confirmText: "Delete",
			destructive: true,
		});
		if (ok) remove.mutate(h.id);
	};

	const allEvents = data?.events ?? [];
	const formats = data?.formats ?? ["json"];

	return (
		<div className="space-y-6">
			<p className="text-sm text-muted-foreground">
				Get a request sent to a URL when something happens to your files.
				Addresses must be public.
			</p>

			{fresh?.secret && (
				<div className="rounded-md border border-primary/40 bg-primary/5 p-3 text-sm">
					<p className="font-medium">Signing secret — shown once</p>
					<div className="mt-1.5 flex items-center gap-2">
						<code className="flex-1 truncate font-mono text-xs">
							{fresh.secret}
						</code>
						<CopyButton value={fresh.secret} />
					</div>
				</div>
			)}

			<form
				className="space-y-3 rounded-md border border-border p-3"
				onSubmit={(e) => {
					e.preventDefault();
					create.mutate();
				}}
			>
				<div className="space-y-1.5">
					<Label htmlFor="wh-url">URL</Label>
					<Input
						id="wh-url"
						type="url"
						required
						placeholder="https://"
						value={url}
						onChange={(e) => setUrl(e.target.value)}
					/>
				</div>
				<div className="space-y-1.5">
					<Label htmlFor="wh-format">Format</Label>
					<select
						id="wh-format"
						value={format}
						onChange={(e) => setFormat(e.target.value)}
						className="h-9 w-full rounded-md border border-input bg-transparent px-2 text-sm"
					>
						{formats.map((f) => (
							<option key={f} value={f}>
								{FORMAT_LABEL[f] ?? f}
							</option>
						))}
					</select>
					<p className="text-xs text-muted-foreground">{FORMAT_HINT[format]}</p>
				</div>
				<fieldset className="space-y-1.5">
					<legend className="text-sm font-medium">Events</legend>
					<div className="grid gap-1.5 sm:grid-cols-2">
						{allEvents.map((ev) => (
							<label key={ev} className="flex items-center gap-2 text-sm">
								<Checkbox
									checked={events.includes(ev)}
									onCheckedChange={(c) =>
										setEvents((cur) =>
											c ? [...cur, ev] : cur.filter((x) => x !== ev),
										)
									}
								/>
								<code className="font-mono text-xs">{ev}</code>
							</label>
						))}
					</div>
				</fieldset>
				<Button
					type="submit"
					size="sm"
					loading={create.isPending}
					disabled={!url || events.length === 0}
					className="gap-1.5"
				>
					<Plus /> Add webhook
				</Button>
			</form>

			{isLoading ? (
				<p className="text-sm text-muted-foreground">Loading…</p>
			) : !data?.webhooks.length ? (
				<p className="text-sm text-muted-foreground">No webhooks yet.</p>
			) : (
				<ul className="space-y-2">
					{data.webhooks.map((h) => (
						<li
							key={h.id}
							className="rounded-md border border-border bg-background/30 p-2.5"
						>
							<div className="flex items-center gap-2">
								<code className="flex-1 truncate font-mono text-xs">
									{h.url}
								</code>
								<Badge variant="secondary">
									{FORMAT_LABEL[h.format] ?? h.format}
								</Badge>
								<Badge variant={h.active ? "success" : "secondary"}>
									{h.active ? "active" : "paused"}
								</Badge>
							</div>
							<div className="mt-1.5 flex flex-wrap items-center justify-between gap-2">
								<p className="text-xs text-muted-foreground">
									{h.events.join(", ")}
									{h.last_triggered_at
										? ` · last ${formatDateTime(h.last_triggered_at)} (${h.last_status ?? "failed"})`
										: " · never fired"}
								</p>
								<div className="flex items-center gap-0.5">
									<Button
										variant="ghost"
										size="sm"
										className="gap-1.5"
										loading={test.isPending && test.variables === h.id}
										onClick={() => test.mutate(h.id)}
									>
										<Send /> Test
									</Button>
									<Button
										variant="ghost"
										size="sm"
										onClick={() => toggle.mutate(h)}
									>
										{h.active ? "Pause" : "Resume"}
									</Button>
									<Button
										variant="ghost"
										size="icon"
										className="text-destructive"
										aria-label="Delete webhook"
										onClick={() => onDelete(h)}
									>
										<Trash2 />
									</Button>
								</div>
							</div>
						</li>
					))}
				</ul>
			)}
		</div>
	);
}
