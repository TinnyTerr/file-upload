import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

// Resolved against this file, not the cwd: a bare `bun test` from the repo root
// globs both workspaces and runs these with the wrong working directory.
const read = (path: string) =>
	readFileSync(resolve(import.meta.dir, "..", path), "utf8");

describe("UI design contracts", () => {
	test("brand tagline uses the requested product slogan", () => {
		expect(read("src/components/layout/Brand.tsx")).toContain("(for files)");
		expect(read("src/components/layout/PublicShell.tsx")).toContain(
			"Oxymoron (for files)",
		);
	});

	// The Files page became the Drive explorer, and the side panel that used to
	// hold a row of upload tabs is gone: the whole explorer is the drop target,
	// so the toolbar only covers what a drag can't express. The tabs became the
	// "Upload ▾" split button, which costs no horizontal room on a phone.
	test("upload methods live in a menu rather than a row of tabs", () => {
		const menu = read("src/features/drive/components/explorer/UploadMenu.tsx");

		expect(menu).toContain('aria-label="More upload options"');
		expect(menu).toContain("DropdownMenuItem");
		// Files, folders and remote-URL uploads are all reachable from it.
		expect(menu).toContain("webkitdirectory");
		expect(menu).toContain("onRemote");
	});

	// On a narrow viewport the two side panes drop away and the file list keeps
	// the full width; `min-w-0` on every pane is what lets them shrink instead
	// of forcing the page to scroll sideways.
	test("explorer side panes become Sheets rather than disappearing on small viewports", () => {
		const shell = read(
			"src/features/drive/components/explorer/ExplorerShell.tsx",
		);

		// Below their breakpoint a resizable Panel has no room left to
		// negotiate, so JS swaps in a Sheet overlay instead of a CSS hide --
		// the nav/details panes stay reachable rather than vanishing outright.
		expect(shell).toContain('useMediaQuery("(min-width: 768px)")');
		expect(shell).toContain('useMediaQuery("(min-width: 1024px)")');
		expect(shell).toContain("<Sheet open={navOpen}");
		expect(shell).toContain("<Sheet open={detailsOpen}");
		expect(shell).toContain('id="main"');
		expect(shell).toContain("min-w-0");
	});

	test("disabled primary buttons do not look like active gradient calls to action", () => {
		const source = read("src/components/ui/button.tsx");

		expect(source).toContain("disabled:bg-muted");
		expect(source).toContain("disabled:text-muted-foreground");
		expect(source).toContain("disabled:shadow-none");
	});

	test("theme avoids the old violet-cyan AI-gradient palette", () => {
		const css = read("src/index.css");

		expect(css).toContain("--background: oklch(0.19 0.006 205)");
		expect(css).toContain("--foreground: oklch(0.91 0.006 110)");
		expect(css).toContain("--primary: oklch(0.64 0.08 155)");
		expect(css).toContain("--accent: oklch(0.74 0.07 82)");
		expect(css).not.toContain("0.62 0.2 285");
		expect(css).not.toContain("0.74 0.13 200");
	});

	test("popup surfaces inherit the app theme", () => {
		const dialog = read("src/components/ui/dialog.tsx");
		const sheet = read("src/components/ui/sheet.tsx");
		const toast = read("src/providers/ToastProvider.tsx");

		expect(dialog).toContain("bg-popover/95");
		expect(sheet).toContain("bg-popover/95");
		// Sonner's own dark/light theme follows the app's live theme rather than
		// being pinned to dark -- ThemeProvider is the one place that changes.
		expect(toast).toContain("useTheme");
		expect(toast).toContain("theme={resolvedTheme}");
		expect(toast).toContain("!bg-popover");
		expect(toast).toContain("!text-popover-foreground");
	});

	test("dropbox receive uploads use chunking and a finalizing phase for large files", () => {
		const service = read("src/features/dropbox/services/dropboxService.ts");
		const page = read("src/features/dropbox/components/DropboxUploadPage.tsx");

		expect(service).toContain("CHUNKED_THRESHOLD");
		expect(service).toContain("/upload/init");
		expect(service).toContain("/upload/chunk");
		expect(service).toContain("/upload/finalize");
		expect(service).toContain('phase: "finalizing"');
		expect(page).toContain('"finalizing"');
	});
});
