import { Component, type ErrorInfo, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { ErrorPage } from "./ErrorPage";

/** A dynamic `import()` that failed. After a deploy the shell is revalidated
 * (`Cache-Control: no-cache`) but an already-open tab still holds the *old*
 * chunk names, and those files are gone — so the first lazy route the user
 * opens throws. That is a stale tab, not a bug: the fix is a reload. */
function isStaleChunk(error: unknown): boolean {
	const msg = error instanceof Error ? error.message : String(error);
	return (
		/dynamically imported module/i.test(msg) ||
		/Importing a module script failed/i.test(msg) ||
		/ChunkLoadError/i.test(msg)
	);
}

interface State {
	error: Error | null;
}

/**
 * Catches anything a render throws, anywhere below it, and shows the error page
 * instead of React's blank white document.
 *
 * Mounted above the router in `main.tsx`: a route element that throws takes the
 * whole tree down with it, so the boundary has to sit outside the tree it is
 * protecting. There is no per-route recovery here on purpose — once a render
 * has thrown, the safe move is a full reload, not resuming from an unknown
 * component state.
 */
export class RootErrorBoundary extends Component<
	{ children: ReactNode },
	State
> {
	state: State = { error: null };

	static getDerivedStateFromError(error: Error): State {
		return { error };
	}

	componentDidCatch(error: Error, info: ErrorInfo) {
		// The only place this is recoverable from: the browser console. There is
		// no error-reporting backend, and shipping stack traces to the server
		// would put user paths and file names in the admin-readable log buffer.
		console.error("unhandled render error", error, info.componentStack);
	}

	render() {
		const { error } = this.state;
		if (!error) return this.props.children;

		const stale = isStaleChunk(error);
		return (
			<ErrorPage
				code={stale ? undefined : 500}
				title={stale ? "A new version is available" : "Something went wrong"}
				description={
					stale
						? "This tab is running an older build that is no longer on the server. Reload to pick up the new one."
						: "The page failed to render. Reloading usually clears it; the details are in the browser console."
				}
				actions={
					<>
						<Button onClick={() => window.location.reload()}>Reload</Button>
						{!stale && (
							<Button
								variant="outline"
								onClick={() => {
									window.location.href = "/";
								}}
							>
								Go home
							</Button>
						)}
					</>
				}
			/>
		);
	}
}
