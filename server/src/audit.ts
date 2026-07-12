import { createHash } from "node:crypto";
import type { Db } from "./db/types.ts";

interface AuditRow {
  entry_hash: string;
}

function nowIso(): string {
  return new Date().toISOString();
}

/** Hash-chained audit log, mirrors app/audit/log.py::record. Each entry's
 * hash covers the previous entry's hash plus this entry's fields, so the
 * chain can be verified for tampering. */
export function recordAudit(
  db: Db,
  entry: { actor: string; action: string; target?: string | null; ip?: string | null },
): void {
  const prev = db.get<AuditRow>("SELECT entry_hash FROM audit_log ORDER BY id DESC LIMIT 1");
  const prevHash = prev?.entry_hash ?? "";
  const createdAt = nowIso();
  const payload = JSON.stringify({
    prevHash,
    actor: entry.actor,
    action: entry.action,
    target: entry.target ?? null,
    ip: entry.ip ?? null,
    createdAt,
  });
  const entryHash = createHash("sha256").update(payload).digest("hex");
  db.run(
    `INSERT INTO audit_log (actor, action, target, ip, created_at, prev_hash, entry_hash)
     VALUES ($actor, $action, $target, $ip, $createdAt, $prevHash, $entryHash)`,
    {
      $actor: entry.actor,
      $action: entry.action,
      $target: entry.target ?? null,
      $ip: entry.ip ?? null,
      $createdAt: createdAt,
      $prevHash: prevHash,
      $entryHash: entryHash,
    },
  );
}
