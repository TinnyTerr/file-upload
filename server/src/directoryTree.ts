import type { DirectoryRow, UserRow } from "./db/rows.ts";
import type { Db } from "./db/types.ts";
import { HttpError } from "./httpError.ts";

interface RoleRow {
	role: string;
}

/** A directory may have at most this many ancestors. Ten is deep enough that
 * nobody hits it by accident and shallow enough that walking a chain on every
 * permission check stays a handful of indexed point lookups. */
export const MAX_DEPTH = 10;

export function getDirectory(db: Db, id: number): DirectoryRow | null {
	return (
		db.get<DirectoryRow>("SELECT * FROM directories WHERE id = $id", {
			$id: id,
		}) ?? null
	);
}

/** Every ancestor of `directoryId`, nearest parent first, up to the root-level
 * folder. The directory itself is not included.
 *
 * Exceeding `MAX_DEPTH` here (or revisiting an id) means the table holds a
 * cycle or an over-deep chain, which create/move both refuse to produce -- so
 * it is corrupt data, not a case to degrade gracefully around. It throws
 * rather than looping forever or silently truncating the chain, since a
 * truncated chain would resolve to the wrong encryption key. */
export function ancestorChain(db: Db, directoryId: number): DirectoryRow[] {
	const chain: DirectoryRow[] = [];
	const seen = new Set<number>([directoryId]);
	let current = getDirectory(db, directoryId);
	while (current?.parent_directory_id != null) {
		const parentId = current.parent_directory_id;
		if (seen.has(parentId)) {
			throw new HttpError(500, `directory tree cycle at directory ${parentId}`);
		}
		const parent = getDirectory(db, parentId);
		// A dangling parent id is treated as "this is where the chain ends"
		// rather than an error: the FK makes it unreachable in practice, and a
		// half-replicated peer shouldn't 500 every read.
		if (!parent) break;
		seen.add(parentId);
		chain.push(parent);
		if (chain.length > MAX_DEPTH) {
			throw new HttpError(
				500,
				`directory tree deeper than ${MAX_DEPTH} at directory ${directoryId}`,
			);
		}
		current = parent;
	}
	return chain;
}

/** Number of ancestors above this directory. A root-level folder is 0. */
export function depthOf(db: Db, directoryId: number): number {
	return ancestorChain(db, directoryId).length;
}

/** Direct child directories of `directoryId`, or of the root when null. */
export function childDirectories(
	db: Db,
	directoryId: number | null,
): DirectoryRow[] {
	if (directoryId === null) {
		return db.all<DirectoryRow>(
			"SELECT * FROM directories WHERE parent_directory_id IS NULL ORDER BY title ASC",
		);
	}
	return db.all<DirectoryRow>(
		"SELECT * FROM directories WHERE parent_directory_id = $id ORDER BY title ASC",
		{ $id: directoryId },
	);
}

/** Every directory at or below `directoryId`, parents always before their own
 * children (so callers that must act bottom-up can simply walk it in reverse). */
export function subtree(db: Db, directoryId: number): DirectoryRow[] {
	const root = getDirectory(db, directoryId);
	if (!root) return [];
	const out: DirectoryRow[] = [root];
	const seen = new Set<number>([root.id]);
	for (let i = 0; i < out.length; i++) {
		for (const child of childDirectories(db, out[i]!.id)) {
			if (seen.has(child.id)) continue; // cycle guard; see ancestorChain
			seen.add(child.id);
			out.push(child);
		}
	}
	return out;
}

/** How many levels the subtree rooted at `directoryId` extends below itself.
 * A folder with no subfolders is 0. Used by move validation: relocating a
 * subtree has to fit its *deepest* member under `MAX_DEPTH`, not just its root. */
export function subtreeHeight(db: Db, directoryId: number): number {
	let height = 0;
	let frontier = childDirectories(db, directoryId).map((d) => d.id);
	const seen = new Set<number>([directoryId, ...frontier]);
	while (frontier.length) {
		height += 1;
		const next: number[] = [];
		for (const id of frontier) {
			for (const child of childDirectories(db, id)) {
				if (seen.has(child.id)) continue;
				seen.add(child.id);
				next.push(child.id);
			}
		}
		frontier = next;
	}
	return height;
}

/** Whether `candidateId` is `directoryId` itself or lives underneath it --
 * the check that keeps a move from parenting a folder to its own descendant. */
export function isSelfOrDescendant(
	db: Db,
	candidateId: number,
	directoryId: number,
): boolean {
	if (candidateId === directoryId) return true;
	return ancestorChain(db, candidateId).some((a) => a.id === directoryId);
}

/** A collaborator grant (or ownership) on a folder applies to everything
 * beneath it, so access is decided by walking from the node up through its
 * ancestors and taking the first answer -- at most MAX_DEPTH indexed lookups.
 * Lives here rather than in routes/directories.ts so routes/files.ts can share
 * the one implementation without the two route modules importing each other. */
export function directoryRole(
	db: Db,
	d: DirectoryRow,
	user: UserRow,
): string | null {
	if (user.role === "master") return "owner";
	for (const node of [d, ...ancestorChain(db, d.id)]) {
		if (node.owner_id === user.id) return "owner";
		const collab = db.get<RoleRow>(
			"SELECT role FROM directory_collaborators WHERE directory_id = $dir AND user_id = $user",
			{ $dir: node.id, $user: user.id },
		);
		if (collab) return collab.role;
	}
	return null;
}

export function isEditor(db: Db, d: DirectoryRow, user: UserRow): boolean {
	const role = directoryRole(db, d, user);
	return role === "owner" || role === "editor";
}

/** The nearest row at-or-above `directory` that holds its own key, i.e. the one
 * whose encryption actually protects `directory`'s contents. Falls back to the
 * topmost ancestor if nothing in the chain is marked overridden (which the
 * schema's default makes impossible for real data, but a partially replicated
 * row shouldn't crash a read path). */
export function nearestOverride(db: Db, directory: DirectoryRow): DirectoryRow {
	if (directory.encryption_overridden) return directory;
	const chain = ancestorChain(db, directory.id);
	for (const ancestor of chain) {
		if (ancestor.encryption_overridden) return ancestor;
	}
	return chain[chain.length - 1] ?? directory;
}

interface PathRow {
	id: number;
	title: string;
	parent_directory_id: number | null;
}

/**
 * A resolver from folder id to its full path of titles, built from **one**
 * query over the whole table.
 *
 * `ancestorChain` costs a query per level, which is right for one folder and
 * wrong for a listing: the admin panel renders every file in the system, and
 * per-row chain walking would be O(files x depth) round trips. Build this once
 * per request and call it per row instead.
 */
export function buildPathIndex(db: Db): (id: number | null) => string[] {
	const rows = db.all<PathRow>(
		"SELECT id, title, parent_directory_id FROM directories",
	);
	const byId = new Map<number, PathRow>(rows.map((r) => [r.id, r]));
	const cache = new Map<number, string[]>();
	return (id: number | null): string[] => {
		if (id === null) return [];
		const hit = cache.get(id);
		if (hit) return hit;
		const parts: string[] = [];
		let current = byId.get(id);
		// Bounded by MAX_DEPTH + 1 so a cycle in corrupt data can't spin here.
		for (let i = 0; current && i <= MAX_DEPTH; i++) {
			parts.unshift(current.title);
			current =
				current.parent_directory_id === null
					? undefined
					: byId.get(current.parent_directory_id);
		}
		cache.set(id, parts);
		return parts;
	};
}
