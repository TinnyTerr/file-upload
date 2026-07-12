import type { Db } from "../db/types.ts";

const MAX_ATTEMPTS = 5;
const LOCKOUT_SECONDS = 900;

interface LoginAttemptRow {
  id: number;
  identifier: string;
  identifier_type: string;
  failed_count: number;
  locked_until: string | null;
  updated_at: string;
}

function nowIso(): string {
  return new Date().toISOString();
}

/** Mirrors app/security/lockout.py::LockoutPolicy: 5 failed attempts per
 * identifier (username or IP, tracked separately) within a 900s window locks
 * that identifier out; only the username counter resets on success. */
export class LockoutPolicy {
  constructor(
    private readonly maxAttempts = MAX_ATTEMPTS,
    private readonly lockoutSeconds = LOCKOUT_SECONDS,
  ) {}

  checkLoginAllowed(db: Db, username: string, ip: string): boolean {
    return this.isLocked(db, username, "username") === false && this.isLocked(db, ip, "ip") === false;
  }

  private isLocked(db: Db, identifier: string, type: string): boolean {
    const row = db.get<LoginAttemptRow>(
      "SELECT * FROM login_attempts WHERE identifier = $identifier AND identifier_type = $type",
      { $identifier: identifier, $type: type },
    );
    if (!row || !row.locked_until) return false;
    return new Date(row.locked_until).getTime() > Date.now();
  }

  recordFailure(db: Db, identifier: string, type: string): void {
    const row = db.get<LoginAttemptRow>(
      "SELECT * FROM login_attempts WHERE identifier = $identifier AND identifier_type = $type",
      { $identifier: identifier, $type: type },
    );
    const failedCount = (row?.failed_count ?? 0) + 1;
    const lockedUntil =
      failedCount >= this.maxAttempts
        ? new Date(Date.now() + this.lockoutSeconds * 1000).toISOString()
        : row?.locked_until ?? null;
    if (row) {
      db.run(
        "UPDATE login_attempts SET failed_count = $failedCount, locked_until = $lockedUntil, updated_at = $now WHERE id = $id",
        { $failedCount: failedCount, $lockedUntil: lockedUntil, $now: nowIso(), $id: row.id },
      );
    } else {
      db.run(
        "INSERT INTO login_attempts (identifier, identifier_type, failed_count, locked_until, updated_at) VALUES ($identifier, $type, $failedCount, $lockedUntil, $now)",
        { $identifier: identifier, $type: type, $failedCount: failedCount, $lockedUntil: lockedUntil, $now: nowIso() },
      );
    }
  }

  resetSuccess(db: Db, username: string): void {
    db.run("DELETE FROM login_attempts WHERE identifier = $identifier AND identifier_type = 'username'", {
      $identifier: username,
    });
  }
}
