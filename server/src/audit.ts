import { createHash } from "node:crypto";
import type { Db } from "./db/types.ts";

interface AuditRow {
  entry_hash: string;
}

interface ChainRow {
  id: number;
  actor: string;
  action: string;
  target: string | null;
  ip: string | null;
  created_at: string;
  prev_hash: string;
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

/** Recomputes the hash chain over every row and checks it matches the stored
 * entry_hash values, detecting tampering or gaps. */
export function verifyAuditChain(db: Db): boolean {
  const rows = db.all<ChainRow>("SELECT * FROM audit_log ORDER BY id ASC");
  let prevHash = "";
  for (const row of rows) {
    if (row.prev_hash !== prevHash) return false;
    const payload = JSON.stringify({
      prevHash,
      actor: row.actor,
      action: row.action,
      target: row.target ?? null,
      ip: row.ip ?? null,
      createdAt: row.created_at,
    });
    const expected = createHash("sha256").update(payload).digest("hex");
    if (expected !== row.entry_hash) return false;
    prevHash = row.entry_hash;
  }
  return true;
}
