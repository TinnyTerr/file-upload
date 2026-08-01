/**
 * Minimal CommonMark-subset renderer for the API reference.
 *
 * The docs live in `docs/api.md` and are bundled into the page at build time,
 * so the only markdown this ever sees is written by us and checked into the
 * repo. That lets it stay a ~300-line parser over React elements (no
 * dangerouslySetInnerHTML, no markdown dependency) covering exactly the
 * constructs that file uses: ATX headings, paragraphs, fenced code, GFM pipe
 * tables, dash lists, and inline code / bold / links.
 *
 * The document is ~1600 lines / ~3500 elements, which makes this one of the
 * few places in the app where render cost is worth engineering around:
 * parsing is memoized on the source string, code blocks use a plain copy
 * button rather than the Radix-backed CopyButton (a hundred tooltip roots on
 * one page is what made this page janky), and every heavyweight block is
 * marked `content-visibility: auto` so offscreen ones cost no layout.
 */

import { Check, Copy } from "lucide-react";
import type React from "react";
import { memo, useEffect, useMemo, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { copyToClipboard } from "@/lib/copy";

/** Skips layout/paint for blocks scrolled out of view. `auto` on the
 * intrinsic size lets the real height take over once a block is rendered, so
 * scroll position doesn't jump around as they come into view. */
const DEFERRED: React.CSSProperties = {
	contentVisibility: "auto",
	containIntrinsicSize: "auto 120px",
};

// ─── inline ─────────────────────────────────────────────────────────────────

const INLINE =
	/`([^`]+)`|\*\*([^*]+)\*\*|\[([^\]]+)\]\(([^)]+)\)|(https?:\/\/[^\s<>()]+)/g;

/** Markdown escapes (`\|` inside table cells, mostly) survive tokenizing, so
 * they're stripped here at the last moment. */
function unescapeMd(text: string): string {
	return text.replace(/\\([\\`*_{}[\]()#+\-.!|])/g, "$1");
}

function renderInline(text: string, keyPrefix: string): React.ReactNode[] {
	const out: React.ReactNode[] = [];
	let last = 0;
	let i = 0;
	INLINE.lastIndex = 0;
	let m = INLINE.exec(text);
	while (m !== null) {
		if (m.index > last) out.push(unescapeMd(text.slice(last, m.index)));
		const key = `${keyPrefix}-i${i++}`;
		const [, code, bold, linkText, linkHref, bareUrl] = m;
		if (code !== undefined) {
			out.push(
				<code
					key={key}
					className="rounded bg-secondary/60 px-1 py-0.5 font-mono text-[0.85em] text-foreground"
				>
					{code}
				</code>,
			);
		} else if (bold !== undefined) {
			out.push(
				<strong key={key} className="font-semibold text-foreground">
					{unescapeMd(bold)}
				</strong>,
			);
		} else if (linkText !== undefined && linkHref !== undefined) {
			out.push(
				<a
					key={key}
					href={linkHref}
					className="text-primary underline underline-offset-2 hover:no-underline"
				>
					{unescapeMd(linkText)}
				</a>,
			);
		} else if (bareUrl !== undefined) {
			out.push(bareUrl);
		}
		last = m.index + m[0].length;
		m = INLINE.exec(text);
	}
	if (last < text.length) out.push(unescapeMd(text.slice(last)));
	return out;
}

// ─── blocks ─────────────────────────────────────────────────────────────────

export function headingSlug(text: string): string {
	return text
		.toLowerCase()
		.replace(/`/g, "")
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "");
}

/** Splits a table row on unescaped pipes, dropping the leading/trailing ones. */
function splitRow(line: string): string[] {
	const cells = line.split(/(?<!\\)\|/);
	if (cells[0].trim() === "") cells.shift();
	if (cells.length && cells[cells.length - 1].trim() === "") cells.pop();
	return cells.map((c) => c.trim());
}

function isTableDivider(line: string): boolean {
	return /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(line);
}

const HEADING_CLASSES: Record<number, string> = {
	1: "text-2xl font-semibold text-foreground",
	2: "text-lg font-semibold text-foreground border-b border-border pb-1",
	3: "text-base font-semibold text-foreground",
	4: "text-sm font-semibold text-foreground",
};

/** The copy affordance for a fenced code block. Deliberately *not*
 * `CopyButton`: that wraps every instance in a Radix tooltip root, and this
 * document has over a hundred code blocks. A `title` attribute says the same
 * thing for free. */
function CodeCopyButton({ value }: { value: string }) {
	const [copied, setCopied] = useState(false);
	const timer = useRef<ReturnType<typeof setTimeout>>(undefined);

	useEffect(() => () => clearTimeout(timer.current), []);

	const onCopy = async () => {
		if (!(await copyToClipboard(value))) return;
		setCopied(true);
		clearTimeout(timer.current);
		timer.current = setTimeout(() => setCopied(false), 1400);
	};

	return (
		<Button
			variant="ghost"
			size="icon"
			onClick={onCopy}
			title={copied ? "Copied!" : "Copy"}
			aria-label="Copy code"
		>
			{copied ? <Check className="text-success" /> : <Copy />}
		</Button>
	);
}

export interface MarkdownHeading {
	level: number;
	text: string;
	id: string;
}

/** Every h2 in the document, in order — used to build the section nav. */
export function extractHeadings(markdown: string): MarkdownHeading[] {
	const out: MarkdownHeading[] = [];
	let inFence = false;
	for (const line of markdown.split("\n")) {
		if (line.startsWith("```")) inFence = !inFence;
		if (inFence) continue;
		const m = /^(#{1,4})\s+(.*)$/.exec(line);
		if (m) {
			const text = m[2].trim();
			out.push({ level: m[1].length, text, id: headingSlug(text) });
		}
	}
	return out;
}

function parseBlocks(markdown: string): React.ReactNode[] {
	const lines = markdown.split("\n");
	const blocks: React.ReactNode[] = [];
	let i = 0;
	let key = 0;

	while (i < lines.length) {
		const line = lines[i];

		// blank
		if (line.trim() === "") {
			i++;
			continue;
		}

		// fenced code
		if (line.startsWith("```")) {
			const body: string[] = [];
			i++;
			while (i < lines.length && !lines[i].startsWith("```")) {
				body.push(lines[i]);
				i++;
			}
			i++; // closing fence
			const code = body.join("\n");
			blocks.push(
				<div key={`b${key++}`} className="relative" style={DEFERRED}>
					<pre className="overflow-x-auto rounded-lg border border-border bg-background/50 p-3 pr-12 font-mono text-xs leading-relaxed whitespace-pre">
						{code}
					</pre>
					<div className="absolute right-2 top-2">
						<CodeCopyButton value={code} />
					</div>
				</div>,
			);
			continue;
		}

		// heading
		const heading = /^(#{1,4})\s+(.*)$/.exec(line);
		if (heading) {
			const level = heading[1].length;
			const text = heading[2].trim();
			const Tag = `h${level}` as "h1" | "h2" | "h3" | "h4";
			blocks.push(
				<Tag
					key={`b${key++}`}
					id={headingSlug(text)}
					className={`scroll-mt-20 ${HEADING_CLASSES[level]}`}
				>
					{renderInline(text, `h${key}`)}
				</Tag>,
			);
			i++;
			continue;
		}

		// table
		if (
			line.trim().startsWith("|") &&
			i + 1 < lines.length &&
			isTableDivider(lines[i + 1])
		) {
			const header = splitRow(line);
			i += 2;
			const rows: string[][] = [];
			while (i < lines.length && lines[i].trim().startsWith("|")) {
				rows.push(splitRow(lines[i]));
				i++;
			}
			blocks.push(
				<div
					key={`b${key++}`}
					className="overflow-x-auto rounded-lg border border-border"
					style={DEFERRED}
				>
					<table className="w-full text-xs">
						<thead>
							<tr className="border-b border-border bg-secondary/30">
								{header.map((h, hi) => (
									<th
										// biome-ignore lint/suspicious/noArrayIndexKey: column position is the identity
										key={hi}
										className="px-3 py-2 text-left font-medium text-muted-foreground"
									>
										{renderInline(h, `th${hi}`)}
									</th>
								))}
							</tr>
						</thead>
						<tbody>
							{rows.map((row, ri) => (
								// biome-ignore lint/suspicious/noArrayIndexKey: row position is the identity
								<tr key={ri} className="border-b border-border last:border-0">
									{row.map((cell, ci) => (
										<td
											// biome-ignore lint/suspicious/noArrayIndexKey: cell position is the identity
											key={ci}
											className={
												ci === 0
													? "px-3 py-2 font-mono text-foreground"
													: "px-3 py-2 text-muted-foreground"
											}
										>
											{renderInline(cell, `td${ri}-${ci}`)}
										</td>
									))}
								</tr>
							))}
						</tbody>
					</table>
				</div>,
			);
			continue;
		}

		// list
		if (/^\s*[-*]\s+/.test(line)) {
			const items: string[] = [];
			while (i < lines.length && /^\s*[-*]\s+/.test(lines[i])) {
				items.push(lines[i].replace(/^\s*[-*]\s+/, ""));
				i++;
			}
			blocks.push(
				<ul
					key={`b${key++}`}
					className="list-disc space-y-1 pl-5 text-sm text-muted-foreground"
				>
					{items.map((item) => (
						<li key={item}>{renderInline(item, item.slice(0, 12))}</li>
					))}
				</ul>,
			);
			continue;
		}

		// paragraph — consume until a blank line or the start of another block.
		// The first line is taken unconditionally: a line the table branch
		// declined (a stray `|` with no divider under it) satisfies the loop's
		// exit condition immediately, and without this the outer while would
		// spin on it forever.
		const para: string[] = [lines[i++].trim()];
		while (
			i < lines.length &&
			lines[i].trim() !== "" &&
			!lines[i].startsWith("```") &&
			!/^#{1,4}\s/.test(lines[i]) &&
			!/^\s*[-*]\s+/.test(lines[i]) &&
			!lines[i].trim().startsWith("|")
		) {
			para.push(lines[i].trim());
			i++;
		}
		const text = para.join(" ");
		blocks.push(
			<p key={`b${key++}`} className="text-sm leading-relaxed">
				{renderInline(text, `p${key}`)}
			</p>,
		);
	}

	return blocks;
}

/** Parsing this document builds ~3500 elements, so it is memoized on the
 * source string and the component is memoized on its props -- an unrelated
 * re-render of the page must not re-parse the whole reference. */
export const Markdown = memo(function Markdown({
	children,
}: {
	children: string;
}) {
	const blocks = useMemo(() => parseBlocks(children), [children]);
	return <div className="space-y-4 text-muted-foreground">{blocks}</div>;
});
