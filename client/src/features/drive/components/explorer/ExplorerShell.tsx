import type { ReactNode } from "react";
import {
	Group,
	Panel,
	Separator,
	useDefaultLayout,
} from "react-resizable-panels";
import { cn } from "@/lib/cn";

const PANEL_IDS = ["nav", "main", "details"];

/**
 * Three-pane explorer chrome: navigation ǀ content ǀ details, with the address
 * bar above and the status bar below.
 *
 * Fixed height with its own internal scrolling, unlike every other page in the
 * app — panes that scroll independently is the whole point of the layout, and
 * it can't be had from a document that scrolls as one.
 */
export function ExplorerShell({
	addressBar,
	commandBar,
	nav,
	main,
	details,
	statusBar,
	navOpen,
	detailsOpen,
}: {
	addressBar: ReactNode;
	commandBar: ReactNode;
	nav: ReactNode;
	main: ReactNode;
	details: ReactNode;
	statusBar: ReactNode;
	navOpen: boolean;
	detailsOpen: boolean;
}) {
	// Pane widths persist per browser, so the layout you set up stays put.
	const layout = useDefaultLayout({
		id: "fu-explorer-panes",
		panelIds: PANEL_IDS,
		storage: localStorage,
	});

	return (
		// The app header is h-14; the explorer takes everything under it.
		<div className="flex h-[calc(100dvh-3.5rem)] flex-col overflow-hidden bg-card">
			{addressBar}
			{commandBar}
			<Group
				orientation="horizontal"
				className="flex min-h-0 flex-1"
				{...layout}
			>
				{navOpen && (
					<>
						<Panel
							id="nav"
							defaultSize="20%"
							minSize="10%"
							maxSize="40%"
							className="hidden min-w-0 md:block"
						>
							{nav}
						</Panel>
						<Handle />
					</>
				)}
				<Panel id="main" minSize="30%" className="min-w-0">
					{main}
				</Panel>
				{detailsOpen && (
					<>
						<Handle />
						<Panel
							id="details"
							defaultSize="24%"
							minSize="15%"
							maxSize="45%"
							className="hidden min-w-0 lg:block"
						>
							{details}
						</Panel>
					</>
				)}
			</Group>
			{statusBar}
		</div>
	);
}

function Handle() {
	return (
		<Separator
			className={cn(
				"relative w-px shrink-0 bg-border outline-none transition-colors",
				"hover:bg-primary/60 focus-visible:bg-primary data-[state=dragging]:bg-primary",
			)}
		>
			{/* The visible seam is 1px; this widens the *grab* area to something a
			    person can actually hit without widening the line. */}
			<span className="absolute inset-y-0 -left-1 -right-1" />
		</Separator>
	);
}
