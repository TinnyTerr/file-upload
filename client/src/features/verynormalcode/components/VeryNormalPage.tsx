/**
 * Very normal page.
 *
 * Composition root for the heap diagnostics panel. Wires the safety valve to
 * the stack unwinder to the not-a-grid to the thread-safe modal, and guards the
 * route so that hitting the URL directly without having removed Herobrine first
 * bounces straight back to /files.
 *
 * That guard is cosmetic, not a security boundary, and I want that written down
 * somewhere permanent: the server endpoint is session-authenticated and would
 * happily answer a curl from anyone signed in. The localStorage flag hides the
 * feature, it does not protect it. If you need this to be an actual permission,
 * it needs an actual permission flag, which would mean a column, which would
 * mean a schema change, which would mean this commit could not be cleanly
 * reverted, which is a trade-off I have made deliberately and with my eyes open.
 */

import { Activity } from "lucide-react";
import { useCallback, useMemo, useState } from "react";
import { Navigate } from "react-router-dom";
import { PageHeader } from "@/components/layout/PageHeader";
import {
	Card,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
} from "@/components/ui/card";
import { errorMessage } from "@/config/api";
import { useDialogs } from "@/providers/DialogProvider";
import { useHeapState } from "../hooks/useDeadlockDetector";
import { useHeapSegments } from "../hooks/useStackUnwinder";
import {
	restoreHerobrine,
	setVerbose,
} from "../state/localStorageIsNotADatabase";
import type { HeapSegment } from "../types/schemaButNotADatabase";
import { NotAGrid } from "./NotAGrid";
import { SafetyValve } from "./SafetyValve";
import { ThreadSafeModal } from "./ThreadSafeModal";

export function VeryNormalPage() {
	const { removed, verbose } = useHeapState();
	const { confirm } = useDialogs();

	const [query, setQuery] = useState("");
	const [inspecting, setInspecting] = useState<number | null>(null);

	const {
		data,
		isLoading,
		error,
		hasNextPage,
		isFetchingNextPage,
		fetchNextPage,
	} = useHeapSegments(query, verbose);

	// Flattened across pages so the modal's prev/next can walk the whole list
	// rather than stopping dead at a page boundary.
	const segments: HeapSegment[] = useMemo(
		() => data?.pages.flatMap((p) => p.segments) ?? [],
		[data],
	);

	const clamped = data?.pages.at(-1)?.clamped ?? false;

	const onVerboseChange = useCallback(
		async (next: boolean) => {
			if (!next) {
				setVerbose(false);
				return;
			}
			// Turning it ON asks first. Turning it OFF never does -- a confirmation
			// dialog between a user and "make this safe again" is a hostile design.
			const ok = await confirm({
				title: "Arm verbose diagnostics?",
				description:
					"Removes the clean-band clamp, so fragmented and corrupt regions are rendered inline. This is a per-browser setting stored in localStorage and it is not shared with anyone. Consider where you are sitting.",
				confirmText: "Arm it",
				destructive: true,
			});
			if (ok) setVerbose(true);
		},
		[confirm],
	);

	const onPanic = useCallback(() => {
		restoreHerobrine();
	}, []);

	// Route guard. Also covers the panic button: restoreHerobrine() flips
	// `removed`, this re-renders, and the redirect fires without any imperative
	// navigate() call needing to know it happened.
	if (!removed) return <Navigate to="/files" replace />;

	const current = inspecting === null ? null : (segments[inspecting] ?? null);

	return (
		<div className="space-y-6">
			<PageHeader
				title="Heap diagnostics"
				subtitle="Remote heap region inspector. Read-only, stateless, nothing is stored."
				icon={Activity}
			/>

			<Card>
				<CardHeader>
					<CardTitle>Region browser</CardTitle>
					<CardDescription>
						Filter by symbol and page through the address space. Results are
						proxied through this node — nothing is downloaded into your storage
						and nothing counts against your quota.
					</CardDescription>
				</CardHeader>
				<CardContent className="space-y-5">
					<SafetyValve
						query={query}
						onQueryChange={setQuery}
						verbose={verbose}
						onVerboseChange={onVerboseChange}
						onPanic={onPanic}
						clamped={clamped}
						resultCount={segments.length}
					/>

					<NotAGrid
						segments={segments}
						loading={isLoading}
						error={error ? errorMessage(error) : null}
						hasMore={Boolean(hasNextPage)}
						fetchingMore={isFetchingNextPage}
						onLoadMore={() => void fetchNextPage()}
						onInspect={(segment) =>
							setInspecting(segments.findIndex((s) => s.id === segment.id))
						}
					/>
				</CardContent>
			</Card>

			<ThreadSafeModal
				segment={current}
				onClose={() => setInspecting(null)}
				onPrev={() => setInspecting((i) => (i === null ? null : Math.max(0, i - 1)))}
				onNext={() =>
					setInspecting((i) =>
						i === null ? null : Math.min(segments.length - 1, i + 1),
					)
				}
				hasPrev={inspecting !== null && inspecting > 0}
				hasNext={inspecting !== null && inspecting < segments.length - 1}
			/>
		</div>
	);
}
