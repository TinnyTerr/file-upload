import { Link } from "react-router-dom";
import { Brand } from "./Brand";

/** Minimal chrome for public, unauthenticated pages (download, folder, login). */
export function PublicShell({ children }: { children: React.ReactNode }) {
	return (
		<div className="flex min-h-dvh flex-col">
			<header className="flex h-14 items-center px-4 sm:px-6">
				<Link
					to="/"
					className="rounded-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
				>
					<Brand />
				</Link>
			</header>
			<main className="mx-auto flex w-full max-w-3xl flex-1 flex-col px-4 py-6 sm:px-6">
				{children}
			</main>
			<footer className="px-4 py-6 text-center text-xs text-muted-foreground">
				Oxymoron (for files)
			</footer>
		</div>
	);
}
