import { useQuery } from "@tanstack/react-query";
import { AlertCircle, BookText, FileDown } from "lucide-react";
import { useMemo } from "react";
import { PageHeader } from "@/components/layout/PageHeader";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { CopyButton } from "@/components/ui/copy-button";
import { Skeleton } from "@/components/ui/skeleton";
import { api, apiPath, errorMessage } from "@/config/api";
import { extractHeadings, Markdown } from "./Markdown";

/** The docs are authored once in `docs/api.md` and served (with this server's
 * own origin substituted into every example) from GET /api/docs.md. This page
 * renders that exact document, so there is no second copy to keep in sync --
 * and the same URL is what an LLM or any other tool is pointed at. */
const DOCS_URL = apiPath("/docs.md");

export function ApiDocsPage() {
	const {
		data: markdown,
		isPending,
		error,
	} = useQuery({
		queryKey: ["api-docs"],
		queryFn: () => api.get<string>("/docs.md"),
		staleTime: 5 * 60 * 1000,
	});

	// The document opens with an h1 that duplicates the page header, so it is
	// dropped from the rendered body and the nav is built from the h2s.
	const body = useMemo(
		() => (markdown ?? "").replace(/^#\s+.*\n/, ""),
		[markdown],
	);
	const sections = useMemo(
		() => extractHeadings(body).filter((h) => h.level === 2),
		[body],
	);

	return (
		<div className="space-y-6">
			<PageHeader
				title="API reference"
				subtitle="Upload, download, and manage files programmatically."
				icon={BookText}
				actions={
					<>
						<CopyButton
							value={new URL(DOCS_URL, window.location.origin).href}
							tooltip="Copy the markdown docs URL"
						/>
						<Button variant="outline" size="sm" asChild>
							<a href={DOCS_URL} target="_blank" rel="noreferrer">
								<FileDown className="size-4" />
								Raw markdown
							</a>
						</Button>
					</>
				}
			/>

			<Card className="border-primary/20 bg-primary/5">
				<CardContent className="pt-4 text-sm text-muted-foreground">
					<p>
						This page renders <code>docs/api.md</code> verbatim. Point an LLM or
						any doc tooling at{" "}
						<a
							href={DOCS_URL}
							target="_blank"
							rel="noreferrer"
							className="font-mono text-primary underline underline-offset-2 hover:no-underline"
						>
							{DOCS_URL}
						</a>{" "}
						to get the same content as markdown, with this server's base URL
						already substituted into every example. The endpoint requires a
						session cookie or an <code>Authorization: Bearer</code> API key.
					</p>
				</CardContent>
			</Card>

			{sections.length > 0 && (
				<nav
					aria-label="API sections"
					className="flex flex-wrap gap-2 rounded-lg border border-border bg-secondary/20 p-2"
				>
					{sections.map((s) => (
						<a
							key={s.id}
							href={`#${s.id}`}
							className="rounded-md px-3 py-1.5 text-sm text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
						>
							{s.text}
						</a>
					))}
				</nav>
			)}

			{isPending && (
				<div className="space-y-3">
					<Skeleton className="h-6 w-48" />
					<Skeleton className="h-24 w-full" />
					<Skeleton className="h-6 w-40" />
					<Skeleton className="h-40 w-full" />
				</div>
			)}

			{error && (
				<Card className="border-destructive/30 bg-destructive/5">
					<CardContent className="flex items-start gap-2 pt-4 text-sm text-muted-foreground">
						<AlertCircle className="mt-0.5 size-4 shrink-0 text-destructive" />
						<span>Couldn't load the API reference: {errorMessage(error)}</span>
					</CardContent>
				</Card>
			)}

			{markdown && (
				<Card>
					<CardContent className="pt-4">
						<Markdown>{body}</Markdown>
					</CardContent>
				</Card>
			)}
		</div>
	);
}
