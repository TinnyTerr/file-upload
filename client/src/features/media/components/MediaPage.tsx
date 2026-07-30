import { Clapperboard, KeyRound } from "lucide-react";
import { useState } from "react";
import { PageHeader } from "@/components/layout/PageHeader";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { Skeleton } from "@/components/ui/skeleton";
import { useMediaLibrary } from "../hooks/useMedia";
import type { MediaCollection } from "../types";
import { MediaPosterCard } from "./MediaPosterCard";
import { PlayKeyManager } from "./PlayKeyManager";

/** The library index — the "browse" surface. Renders for signed-out visitors
 * too, in which case it only ever contains public collections. */
export function MediaPage() {
	const { data, isLoading } = useMediaLibrary();
	const [showKeys, setShowKeys] = useState(false);

	const collections = data?.collections ?? [];
	const restricted = collections.filter((c) => c.visibility === "restricted");
	const open = collections.filter((c) => c.visibility === "public");

	return (
		<div className="space-y-6">
			<PageHeader
				title="Library"
				subtitle="Stream anything published here in the browser, or with a play key in mpv."
				icon={Clapperboard}
				actions={
					data?.viewer ? (
						<Button
							variant={showKeys ? "secondary" : "outline"}
							onClick={() => setShowKeys((v) => !v)}
						>
							<KeyRound className="size-4" />
							Play keys
						</Button>
					) : undefined
				}
			/>

			{showKeys && data?.viewer && <PlayKeyManager />}

			{isLoading ? (
				<div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4">
					{[0, 1, 2, 3].map((i) => (
						<Skeleton key={i} className="aspect-[4/3] rounded-xl" />
					))}
				</div>
			) : collections.length === 0 ? (
				<EmptyState
					icon={Clapperboard}
					title="Nothing published yet"
					description={
						data?.viewer
							? "Publish a folder of video or audio from the Files page and it shows up here."
							: "Sign in to see titles that are restricted to accounts."
					}
				/>
			) : (
				<div className="space-y-8">
					<Row title="Available to you" collections={restricted} />
					<Row title="Public" collections={open} />
				</div>
			)}
		</div>
	);
}

function Row({
	title,
	collections,
}: {
	title: string;
	collections: MediaCollection[];
}) {
	if (collections.length === 0) return null;
	return (
		<section className="space-y-3">
			<h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
				{title}
			</h2>
			<div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4">
				{collections.map((c) => (
					<MediaPosterCard key={c.slug} collection={c} />
				))}
			</div>
		</section>
	);
}
