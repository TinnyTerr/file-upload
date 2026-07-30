import { Link, Outlet } from "react-router-dom";
import { AppShell } from "@/components/layout/AppShell";
import { Brand } from "@/components/layout/Brand";
import { FullPageSpinner } from "@/components/layout/FullPageSpinner";
import { Button } from "@/components/ui/button";
import { useAuth } from "@/features/auth/hooks/auth";

/** The library is the one surface serving both audiences, so it can't sit
 * under `RequireAuth`: a visitor following a link to a public collection has to
 * reach it without an account. Signed-in users still get the normal app chrome
 * (AppShell renders the same <Outlet/>); everyone else gets a wide public
 * layout — PublicShell's max-w-3xl is too narrow for a poster grid. */
export function WatchLayout() {
	const { isAuthenticated, isLoading } = useAuth();

	if (isLoading) return <FullPageSpinner />;
	if (isAuthenticated) return <AppShell />;

	return (
		<div className="flex min-h-dvh flex-col">
			<header className="flex h-14 items-center justify-between px-4 sm:px-6">
				<Link
					to="/"
					className="rounded-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
				>
					<Brand />
				</Link>
				<Button asChild variant="outline" size="sm">
					<Link to="/login">Sign in</Link>
				</Button>
			</header>
			<main className="mx-auto w-full max-w-6xl flex-1 px-4 py-6 sm:px-6 lg:py-8">
				<Outlet />
			</main>
			<footer className="px-4 py-6 text-center text-xs text-muted-foreground">
				Oxymoron (for files)
			</footer>
		</div>
	);
}
