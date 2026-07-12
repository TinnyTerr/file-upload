// Argon2id via Bun's built-in password hasher. Fresh hashes only -- not
// byte-compatible with the Python argon2-cffi hashes from the old backend,
// which is fine since this targets a fresh DB, not an in-place upgrade.

const DUMMY_HASH = await Bun.password.hash("__timing_dummy_password_never_valid__", {
  algorithm: "argon2id",
});

export async function hashPassword(password: string): Promise<string> {
  return Bun.password.hash(password, { algorithm: "argon2id" });
}

export async function verifyPassword(password: string, hash: string): Promise<boolean> {
  return Bun.password.verify(password, hash);
}

/** Always does a real Argon2 verify against a fixed dummy hash, so response
 * latency for unknown usernames matches that of real ones (timing-attack
 * mitigation, mirrors the Python backend's _DUMMY_HASH trick). */
export async function verifyDummyPassword(password: string): Promise<void> {
  await Bun.password.verify(password, DUMMY_HASH);
}
