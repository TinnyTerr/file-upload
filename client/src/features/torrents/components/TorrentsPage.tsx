import { Download } from "lucide-react";
import { PageHeader } from "@/components/layout/PageHeader";
import {
	Card,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
} from "@/components/ui/card";
import { useDialogs } from "@/providers/DialogProvider";
import { useTorrents } from "../hooks/useTorrents";
import type { TorrentJob } from "../types";
import { AddTorrentCard } from "./AddTorrentCard";
import { TorrentList } from "./TorrentList";

export function TorrentsPage() {
	const { config, list, add, retry, remove } = useTorrents();
	const { confirm } = useDialogs();

	const onRemove = async (t: TorrentJob) => {
		const inFlight =
			t.status === "queued" ||
			t.status === "downloading" ||
			t.status === "fetching" ||
			t.status === "importing";
		const title =
			t.status === "pending"
				? "Remove from the queue?"
				: t.status === "seeding"
					? "Stop seeding?"
					: inFlight
						? "Cancel this torrent?"
						: "Remove from the list?";
		const description =
			t.status === "pending"
				? "It hasn't started yet, so nothing has been downloaded."
				: t.status === "seeding"
					? "The torrent is removed from qBittorrent and its downloaded copy is deleted from the host. Your imported files are kept."
					: inFlight
						? t.provider === "debrid"
							? "The transfer stops, and the torrent and any partial data are removed from Real-Debrid."
							: "The download stops and the partially downloaded data is deleted from the host."
						: "Files already imported into your storage are kept — delete those from the files page.";
		const ok = await confirm({
			title,
			description,
			confirmText:
				t.status === "seeding"
					? "Stop seeding"
					: inFlight
						? "Cancel torrent"
						: "Remove",
			destructive: true,
		});
		if (ok) remove.mutate(t.id);
	};

	return (
		<div className="space-y-6">
			<PageHeader
				title="Torrents"
				subtitle="Download torrents on the host and import them straight into your storage."
				icon={Download}
			/>

			<AddTorrentCard
				config={config.data}
				onAdd={(input) => add.mutateAsync(input)}
				pending={add.isPending}
			/>

			<Card>
				<CardHeader>
					<CardTitle>Your torrents</CardTitle>
					<CardDescription>
						Finished downloads are imported automatically and count against your
						quota.
					</CardDescription>
				</CardHeader>
				<CardContent>
					<TorrentList
						torrents={list.data}
						loading={list.isLoading}
						onRetry={(id) => retry.mutate(id)}
						onRemove={onRemove}
					/>
				</CardContent>
			</Card>
		</div>
	);
}
