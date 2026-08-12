import { Link, useLocation, useNavigate } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { ErrorPage } from "./ErrorPage";

/**
 * The client-side 404.
 *
 * The catch-all route used to bounce to `/`, which silently swallowed typos and
 * dead links: a shared URL that no longer resolves looked exactly like a normal
 * visit to the app. Showing the address that failed is the whole point.
 */
export function NotFoundPage() {
	const { pathname } = useLocation();
	const navigate = useNavigate();

	return (
		<ErrorPage
			code={404}
			title="Page not found"
			description={
				<>
					Nothing lives at{" "}
					<code className="rounded bg-secondary/60 px-1.5 py-0.5 font-mono text-xs">
						{pathname}
					</code>
					. The link may be wrong, or whatever was here has been removed.
				</>
			}
			actions={
				<>
					<Button asChild>
						<Link to="/">Go home</Link>
					</Button>
					<Button variant="outline" onClick={() => navigate(-1)}>
						Go back
					</Button>
				</>
			}
		/>
	);
}
