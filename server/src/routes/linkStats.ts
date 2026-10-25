import { Router } from "express";
import type { AppState } from "../appState.ts";
import type { DirectoryRow, FileRow, LinkRow } from "../db/rows.ts";
import { type LinkKind, linkStats } from "../linkStats.ts";
import { requireActiveUser } from "../middleware/deps.ts";

const MAX_DAYS = 90;

/** `GET /api/link-stats/:kind/:linkId?days=30` -- what a share link has been
 * doing. Read-only and owner-scoped (masters see all): the link's file or
 * folder must be the caller's, the same test the link edit routes use. */
export function linkStatsRouter(state: AppState): Router {
	const router = Router();
	const { db } = state;

	router.get("/:kind/:linkId", requireActiveUser(state), (req, res) => {
		const user = req.currentUser!;
		const kind = req.params.kind as LinkKind;
		if (kind !== "file" && kind !== "dir") {
			res.status(404).json({ detail: "not found" });
			return;
		}
		const id = Number(req.params.linkId);
		if (!Number.isInteger(id)) {
			res.status(404).json({ detail: "not found" });
			return;
		}
		let ownerId: number | undefined;
		if (kind === "file") {
			const link = db.get<LinkRow>("SELECT * FROM links WHERE id = $id", {
				$id: id,
			});
			if (link) {
				ownerId = db.get<FileRow>("SELECT * FROM files WHERE id = $f", {
					$f: link.file_id,
				})?.owner_id;
			}
		} else {
			const link = db.get<{ directory_id: number }>(
				"SELECT directory_id FROM directory_links WHERE id = $id",
				{ $id: id },
			);
			if (link) {
				ownerId = db.get<DirectoryRow>(
					"SELECT * FROM directories WHERE id = $d",
					{ $d: link.directory_id },
				)?.owner_id;
			}
		}
		if (ownerId === undefined) {
			res.status(404).json({ detail: "not found" });
			return;
		}
		if (user.role !== "master" && ownerId !== user.id) {
			res.status(403).json({ detail: "not your link" });
			return;
		}
		const raw = Number(req.query.days ?? 30);
		const days = Number.isFinite(raw)
			? Math.min(MAX_DAYS, Math.max(1, Math.trunc(raw)))
			: 30;
		res.json(linkStats(db, kind, id, days));
	});

	return router;
}
