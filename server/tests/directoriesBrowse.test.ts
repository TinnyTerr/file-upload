/**
 * `GET /api/directories` — the one endpoint that reads the tree.
 *
 * The shape under test is that *search parameters*, not paths, choose which
 * read you get: browsing a level, walking a subtree, listing everything
 * reachable, and searching are the same request with different arguments.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
	type Harness,
	makeDirectory,
	makeFile,
	makeHarness,
	makeUser,
} from "./harness.ts";

interface BrowseResponse {
	directory: { id: number; title: string } | null;
	breadcrumbs: { id: number; title: string }[];
	directories: { id: number; title: string; path?: string[] }[];
	files: { id: number; original_filename: string; path?: string[] }[];
	scope: string;
	query: string | null;
	total: { directories: number; files: number };
	limit: number;
	offset: number;
}

let h: Harness;
let cookie: string;
let userId: number;
// Work/           <- root folder
//   Projects/     <- nested
//     Invoices/   <- nested deeper, holds invoice.pdf
//   notes.txt
// Personal/       <- second root folder
// loose.txt       <- at the drive root, no folder
let work: number;
let projects: number;
let invoices: number;
let personal: number;

beforeEach(async () => {
	h = await makeHarness();
	const user = await makeUser(h.db, "alice");
	userId = user.id;
	cookie = h.signIn(user).cookie;

	work = makeDirectory(h.db, { ownerId: userId, title: "Work" });
	projects = makeDirectory(h.db, {
		ownerId: userId,
		title: "Projects",
		parentId: work,
	});
	invoices = makeDirectory(h.db, {
		ownerId: userId,
		title: "Invoices",
		parentId: projects,
	});
	personal = makeDirectory(h.db, { ownerId: userId, title: "Personal" });

	makeFile(h.db, { ownerId: userId, name: "notes.txt", directoryId: work });
	makeFile(h.db, {
		ownerId: userId,
		name: "invoice.pdf",
		directoryId: invoices,
	});
	makeFile(h.db, { ownerId: userId, name: "loose.txt" });
});

afterEach(() => h.close());

async function browse(query = ""): Promise<BrowseResponse> {
	const res = await h.request(`/api/directories${query}`, { cookie });
	expect(res.status).toBe(200);
	return (await res.json()) as BrowseResponse;
}

describe("scope=level (the default)", () => {
	test("no parameters at all lists the drive root", async () => {
		const body = await browse();
		expect(body.scope).toBe("level");
		expect(body.directory).toBeNull();
		expect(body.breadcrumbs).toEqual([]);
		expect(body.directories.map((d) => d.title).sort()).toEqual([
			"Personal",
			"Work",
		]);
		// Only the file that sits outside every folder.
		expect(body.files.map((f) => f.original_filename)).toEqual(["loose.txt"]);
	});

	test("parent=root is the same as omitting it", async () => {
		expect(await browse("?parent=root")).toEqual(await browse());
	});

	test("a parent id lists exactly one level, not the subtree", async () => {
		const body = await browse(`?parent=${work}`);
		expect(body.directory?.title).toBe("Work");
		expect(body.directories.map((d) => d.title)).toEqual(["Projects"]);
		// "Invoices" is a grandchild and must not appear.
		expect(body.directories.map((d) => d.title)).not.toContain("Invoices");
		expect(body.files.map((f) => f.original_filename)).toEqual(["notes.txt"]);
	});

	test("breadcrumbs are the root-first chain ending at the folder itself", async () => {
		const body = await browse(`?parent=${invoices}`);
		expect(body.breadcrumbs.map((b) => b.title)).toEqual([
			"Work",
			"Projects",
			"Invoices",
		]);
	});

	test("a plain level browse omits path — every row is in the folder asked for", async () => {
		const body = await browse(`?parent=${work}`);
		expect(body.directories[0]?.path).toBeUndefined();
		expect(body.files[0]?.path).toBeUndefined();
	});
});

describe("scope=subtree", () => {
	test("returns every descendant, recursively", async () => {
		const body = await browse(`?parent=${work}&scope=subtree`);
		expect(body.directories.map((d) => d.title)).toEqual([
			"Invoices",
			"Projects",
		]);
		// Both the bounding folder's own file and the deep one.
		expect(body.files.map((f) => f.original_filename)).toEqual([
			"invoice.pdf",
			"notes.txt",
		]);
	});

	test("stays inside the bounding folder", async () => {
		const body = await browse(`?parent=${personal}&scope=subtree`);
		expect(body.directories).toEqual([]);
		expect(body.files).toEqual([]);
	});
});

describe("scope=all", () => {
	test("lists every folder the caller can reach and ignores parent", async () => {
		const body = await browse(`?scope=all&parent=${personal}`);
		expect(body.directories.map((d) => d.title)).toEqual([
			"Invoices",
			"Personal",
			"Projects",
			"Work",
		]);
		// parent is ignored, so it cannot have scoped the response.
		expect(body.directory).toBeNull();
		expect(body.breadcrumbs).toEqual([]);
	});
});

describe("q — search", () => {
	test("matches folder titles and file names, case-insensitively", async () => {
		const body = await browse("?scope=all&q=invoice");
		expect(body.directories.map((d) => d.title)).toEqual(["Invoices"]);
		expect(body.files.map((f) => f.original_filename)).toEqual(["invoice.pdf"]);
		expect(body.query).toBe("invoice");
	});

	test("bounded by parent when scoped to a subtree", async () => {
		const inside = await browse(`?parent=${work}&scope=subtree&q=invoice`);
		expect(inside.files.map((f) => f.original_filename)).toEqual([
			"invoice.pdf",
		]);

		const outside = await browse(`?parent=${personal}&scope=subtree&q=invoice`);
		expect(outside.files).toEqual([]);
		expect(outside.directories).toEqual([]);
	});

	test("results carry the folder path they were found at", async () => {
		const body = await browse("?scope=all&q=invoice.pdf");
		expect(body.files[0]?.path).toEqual(["Work", "Projects", "Invoices"]);
	});

	test("a search that matches nothing is an empty result, not an error", async () => {
		const body = await browse("?scope=all&q=zzzznope");
		expect(body.directories).toEqual([]);
		expect(body.files).toEqual([]);
		expect(body.total).toEqual({ directories: 0, files: 0 });
	});
});

describe("type", () => {
	test("type=directories drops files", async () => {
		const body = await browse("?scope=all&type=directories");
		expect(body.directories.length).toBeGreaterThan(0);
		expect(body.files).toEqual([]);
	});

	test("type=files drops directories", async () => {
		const body = await browse("?scope=all&type=files");
		expect(body.directories).toEqual([]);
		expect(body.files.length).toBeGreaterThan(0);
	});
});

describe("paging", () => {
	test("limit and offset page the result, and total counts before paging", async () => {
		const first = await browse("?scope=all&type=directories&limit=2");
		expect(first.directories.map((d) => d.title)).toEqual([
			"Invoices",
			"Personal",
		]);
		// The count a client needs to know more remain.
		expect(first.total.directories).toBe(4);

		const second = await browse("?scope=all&type=directories&limit=2&offset=2");
		expect(second.directories.map((d) => d.title)).toEqual([
			"Projects",
			"Work",
		]);
	});
});

describe("validation and access", () => {
	test("rejects an unknown scope", async () => {
		const res = await h.request("/api/directories?scope=everything", {
			cookie,
		});
		expect(res.status).toBe(400);
	});

	test("rejects an unknown type", async () => {
		const res = await h.request("/api/directories?type=folders", { cookie });
		expect(res.status).toBe(400);
	});

	test("rejects a non-numeric parent that isn't 'root'", async () => {
		const res = await h.request("/api/directories?parent=../etc", { cookie });
		expect(res.status).toBe(400);
	});

	test("a missing folder is 404", async () => {
		const res = await h.request("/api/directories?parent=999999", { cookie });
		expect(res.status).toBe(404);
	});

	test("someone else's folder is 403, and its contents never leak", async () => {
		const bob = await makeUser(h.db, "bob");
		const bobCookie = h.signIn(bob).cookie;

		const res = await h.request(`/api/directories?parent=${work}`, {
			cookie: bobCookie,
		});
		expect(res.status).toBe(403);

		// Nor may a search reach across the account boundary.
		const search = await h.request("/api/directories?scope=all&q=invoice", {
			cookie: bobCookie,
		});
		const body = (await search.json()) as BrowseResponse;
		expect(body.directories).toEqual([]);
		expect(body.files).toEqual([]);
	});

	test("requires authentication", async () => {
		const res = await h.request("/api/directories");
		expect(res.status).toBe(401);
	});
});

describe("collaborator reach", () => {
	test("a grant on a folder exposes its whole subtree to scope=all", async () => {
		const bob = await makeUser(h.db, "bob");
		const bobCookie = h.signIn(bob).cookie;
		h.db.run(
			`INSERT INTO directory_collaborators (directory_id, user_id, invited_by_id, created_at)
       VALUES ($dir, $user, $by, datetime('now'))`,
			{ $dir: work, $user: bob.id, $by: userId },
		);

		const res = await h.request("/api/directories?scope=all", {
			cookie: bobCookie,
		});
		const body = (await res.json()) as BrowseResponse;
		// The granted folder *and* everything beneath it -- a grant covers the
		// subtree, so the reachable set is not just the row the grant names.
		expect(body.directories.map((d) => d.title).sort()).toEqual([
			"Invoices",
			"Projects",
			"Work",
		]);
		expect(body.directories.map((d) => d.title)).not.toContain("Personal");
	});
});
