import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const read = (path: string) => readFileSync(path, "utf8");

describe("UI design contracts", () => {
	test("brand tagline uses the requested product slogan", () => {
		expect(read("src/components/layout/Brand.tsx")).toContain("(for files)");
		expect(read("src/components/layout/PublicShell.tsx")).toContain(
			"Oxymoron (for files)",
		);
	});

	// The Files page became the Drive explorer; the panel that used to hold four
	// upload tabs now holds the two that aren't "pick files from this machine".
	test("upload tabs fit narrow mobile viewports", () => {
		const source = read("src/features/drive/components/DriveSidePanel.tsx");
		const page = read("src/features/drive/components/DrivePage.tsx");

		expect(source).toContain('aria-label="Upload method"');
		expect(source).toContain("!grid");
		expect(source).toContain("grid-cols-2");
		expect(page).toContain("lg:grid-cols-[minmax(0,1fr)_320px]");
		expect(page).toContain("order-2 min-w-0");
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

	test("popup surfaces inherit the dark app theme", () => {
		const dialog = read("src/components/ui/dialog.tsx");
		const sheet = read("src/components/ui/sheet.tsx");
		const toast = read("src/providers/ToastProvider.tsx");

		expect(dialog).toContain("bg-popover/95");
		expect(sheet).toContain("bg-popover/95");
		expect(toast).toContain('theme="dark"');
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
