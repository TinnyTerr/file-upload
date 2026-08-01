import { BookText, FileDown } from "lucide-react";
import { useMemo } from "react";
import { PageHeader } from "@/components/layout/PageHeader";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { CopyButton } from "@/components/ui/copy-button";
import { apiPath } from "@/config/api";
import { apiDocsBody } from "../apiDocs";
import { extractHeadings, Markdown } from "./Markdown";

/** The docs are authored once in `docs/api.md`, bundled into this page at
 * build time (see ../apiDocs.ts) and served raw from GET /api/docs.md. There
 * is one document either way -- this page just doesn't need the request, and
 * the same URL is what an LLM or any other tool is pointed at. */
const DOCS_URL = apiPath("/docs.md");

export function ApiDocsPage() {
	// The document opens with an h1 that duplicates the page header, so the
	// rendered body drops it and the nav is built from the h2s.
	const sections = useMemo(
		() => extractHeadings(apiDocsBody).filter((h) => h.level === 2),
		[],
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

			<Card>
				<CardContent className="pt-4">
					<Markdown>{apiDocsBody}</Markdown>
				</CardContent>
			</Card>
		</div>
	);
}
