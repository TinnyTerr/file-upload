import { randomBytes } from "node:crypto";
import { recordAudit } from "./audit.ts";
import type { Db } from "./db/types.ts";
import { hashPassword } from "./security/passwords.ts";

const DEFAULT_USERNAME = "admin";

function nowIso(): string {
	return new Date().toISOString();
}

function tokenUrlsafe(bytes: number): string {
	return randomBytes(bytes).toString("base64url");
}

interface CountRow {
	n: number;
}

/** Mirrors app/bootstrap.py::ensure_master: only runs when `users` is empty.
 * Creates the "admin" master user with a random one-time password, seeds a
 * full-access permissions row, and writes an audit entry. Returns the
 * plaintext password (print once) or null if a user already existed. */
export async function ensureMaster(
	db: Db,
	print: (line: string) => void = console.log,
): Promise<string | null> {
	const { n } = db.get<CountRow>("SELECT COUNT(*) as n FROM users")!;
	if (n > 0) return null;

	const password = tokenUrlsafe(12);
	const passwordHash = await hashPassword(password);
	const createdAt = nowIso();

	const userId = db.transaction(() => {
		db.run(
			// credential_version_local = 1 claims the material this node just
			// minted, at the version the column defaults to (§5.10). Without it the
			// seeded master would read as "holds nothing" and try to fetch its own
			// password from an upstream that does not exist.
			`INSERT INTO users (username, password_hash, credential_version_local, role, must_change_credentials, created_at)
       VALUES ($username, $passwordHash, 1, 'master', 1, $createdAt)`,
			{
				$username: DEFAULT_USERNAME,
				$passwordHash: passwordHash,
				$createdAt: createdAt,
			},
		);
		const { id } = db.get<{ id: number }>("SELECT last_insert_rowid() as id")!;

		db.run(
			`INSERT INTO permissions (
         user_id, can_upload, can_upload_client_encrypted, can_delete, can_regenerate_links,
         can_delete_links, can_create_directories, can_manage_lifecycle, can_use_api_keys,
         can_view_admin, can_manage_users, can_manage_storage, can_manage_api_keys, can_manage_cluster,
         can_use_torrents, can_watch_media, quota_bytes, max_file_bytes, archive_after_idle_days, created_at
       ) VALUES ($userId, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 107374182400, 10737418240, 5, $createdAt)`,
			{ $userId: id, $createdAt: createdAt },
		);

		recordAudit(db, {
			actor: "system",
			action: "bootstrap.master_created",
			target: `user:${id}`,
		});
		return id;
	});

	print("=".repeat(60));
	print(" FIRST-RUN ADMIN CREATED");
	print(`   username: ${DEFAULT_USERNAME}`);
	print(`   password: ${password}`);
	print("   You MUST change the username and password on first login.");
	print("=".repeat(60));

	void userId;
	return password;
}
