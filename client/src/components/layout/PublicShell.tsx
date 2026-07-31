import { createContext, useContext, useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { Brand } from "./Brand";

type ShellWidth = "narrow" | "wide";

const WidthContext = createContext<(width: ShellWidth) => void>(() => {});

/**
 * Widen the shell for as long as the calling component is mounted.
 *
 * A public page can't be given a layout prop from the router — nothing knows
 * whether a shared folder is a gallery until its info request comes back — so
 * the page asks from the inside and the shell reverts when it unmounts.
 */
export function usePublicShellWidth(width: ShellWidth): void {
	const setWidth = useContext(WidthContext);
	useEffect(() => {
		setWidth(width);
		return () => setWidth("narrow");
	}, [setWidth, width]);
}

/** Minimal chrome for public, unauthenticated pages (download, folder, login). */
export function PublicShell({ children }: { children: React.ReactNode }) {
	const [width, setWidth] = useState<ShellWidth>("narrow");
	// Identity has to be stable: it's a dependency of the effect above, and a
	// fresh function every render would re-run it forever.
	const setter = useMemo(() => setWidth, []);

	return (
		<WidthContext.Provider value={setter}>
			<div className="flex min-h-dvh flex-col">
				<header className="flex h-14 items-center px-4 sm:px-6">
					<Link
						to="/"
						className="rounded-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
					>
						<Brand />
					</Link>
				</header>
				<main
					className={`mx-auto flex w-full flex-1 flex-col px-4 py-6 sm:px-6 ${
						width === "wide" ? "max-w-6xl" : "max-w-3xl"
					}`}
				>
					{children}
				</main>
				<footer className="px-4 py-6 text-center text-xs text-muted-foreground">
					Oxymoron (for files)
				</footer>
			</div>
		</WidthContext.Provider>
	);
}
