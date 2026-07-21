import type { Db } from "../db/types.ts";
import type { CredentialRow } from "../db/rows.ts";
import { nowIso } from "../db/rows.ts";

export function listForUser(db: Db, userId: number): CredentialRow[] {
  return db.all<CredentialRow>(
    "SELECT * FROM credentials WHERE user_id = $userId ORDER BY created_at ASC",
    { $userId: userId },
  );
}

export function getById(db: Db, id: number): CredentialRow | undefined {
  return db.get<CredentialRow>("SELECT * FROM credentials WHERE id = $id", { $id: id });
}

export function findWebauthnByCredentialId(db: Db, webauthnId: string): CredentialRow | undefined {
  return db.get<CredentialRow>(
    "SELECT * FROM credentials WHERE kind = 'webauthn' AND webauthn_id = $webauthnId",
    { $webauthnId: webauthnId },
  );
}

export function createTotp(db: Db, userId: number, encryptedSecret: Buffer, label: string | null): number {
  const createdAt = nowIso();
  db.run(
    `INSERT INTO credentials (user_id, kind, secret_blob, label, created_at)
     VALUES ($userId, 'totp', $secret, $label, $createdAt)`,
    { $userId: userId, $secret: encryptedSecret, $label: label, $createdAt: createdAt },
  );
  return db.get<{ id: number }>("SELECT last_insert_rowid() as id")!.id;
}

export function createWebauthn(
  db: Db,
  userId: number,
  webauthnId: string,
  publicKey: Buffer,
  transports: string[] | null,
  label: string | null,
): number {
  const createdAt = nowIso();
  db.run(
    `INSERT INTO credentials (user_id, kind, webauthn_id, webauthn_public_key, sign_count, transports, label, created_at)
     VALUES ($userId, 'webauthn', $webauthnId, $publicKey, 0, $transports, $label, $createdAt)`,
    {
      $userId: userId,
      $webauthnId: webauthnId,
      $publicKey: publicKey,
      $transports: transports ? JSON.stringify(transports) : null,
      $label: label,
      $createdAt: createdAt,
    },
  );
  return db.get<{ id: number }>("SELECT last_insert_rowid() as id")!.id;
}

export function deleteCredential(db: Db, userId: number, credentialId: number): boolean {
  const row = db.get<{ id: number }>(
    "SELECT id FROM credentials WHERE id = $id AND user_id = $userId",
    { $id: credentialId, $userId: userId },
  );
  if (!row) return false;
  db.run("DELETE FROM credentials WHERE id = $id", { $id: credentialId });
  return true;
}

export function touchLastUsed(db: Db, credentialId: number): void {
  db.run("UPDATE credentials SET updated_at = $now WHERE id = $id", { $now: nowIso(), $id: credentialId });
}

export function bumpSignCount(db: Db, credentialId: number, newCount: number): void {
  db.run(
    "UPDATE credentials SET sign_count = $count, updated_at = $now WHERE id = $id",
    { $count: newCount, $now: nowIso(), $id: credentialId },
  );
}
