import { useEffect, useState } from "react";
import { Outlet, useMatch } from "react-router-dom";
import { cn } from "@/lib/cn";
import { Header } from "./Header";
import { DesktopSidebar } from "./Sidebar";

const COLLAPSE_KEY = "fu_sidebar_collapsed";

/** Authenticated layout: collapsible sidebar + sticky header + routed content. */
export function AppShell() {
	const [collapsed, setCollapsed] = useState(
		() => localStorage.getItem(COLLAPSE_KEY) === "1",
	);
	// The explorer is full-bleed and manages its own height and scrolling: its
	// three panes scroll independently, which a centred, page-scrolling column
	// can't express. Nothing else on the site changes.
	// Both matches are evaluated unconditionally: `||` between two `useMatch`
	// calls short-circuits the second one, which is a conditional hook.
	const filesRoot = useMatch("/files");
	const filesFolder = useMatch("/files/:dirId");
	const isExplorer = filesRoot !== null || filesFolder !== null;

	useEffect(() => {
		localStorage.setItem(COLLAPSE_KEY, collapsed ? "1" : "0");
	}, [collapsed]);

	return (
		<div
			className={cn("flex", isExplorer ? "h-dvh overflow-hidden" : "min-h-dvh")}
		>
			<DesktopSidebar
				collapsed={collapsed}
				onToggle={() => setCollapsed((c) => !c)}
			/>
			<div className="flex min-w-0 flex-1 flex-col">
				<Header />
				<main
					className={cn(
						"w-full flex-1",
						isExplorer
							? "min-h-0"
							: "mx-auto max-w-6xl px-4 py-6 sm:px-6 lg:py-8",
					)}
				>
					<Outlet />
				</main>
			</div>
		</div>
	);
}
