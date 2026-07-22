import { randomBytes } from "node:crypto";
import { Router } from "express";
import { authenticator } from "otplib";
import type { AppState } from "../appState.ts";
import { requireSession, clientIp } from "../middleware/auth.ts";
import { requireCsrf } from "../security/csrf.ts";
import { verifyPassword } from "../security/passwords.ts";
import { getMasterKey } from "../config.ts";
import { sealSecret } from "../crypto/secretEncrypt.ts";
import { recordAudit } from "../audit.ts";
import * as credentials from "../security/credentials.ts";
import {
  resolveRpContext,
  buildRegistrationOptions,
  takeRegistrationChallenge,
  verifyRegistration,
} from "../security/webauthn.ts";
import type { UserRow } from "../db/rows.ts";

function ensureWebauthnUserHandle(db: import("../db/types.ts").Db, user: UserRow): string {
  if (user.webauthn_user_handle) return user.webauthn_user_handle;
  const handle = randomBytes(32).toString("base64url");
  db.run("UPDATE users SET webauthn_user_handle = $handle WHERE id = $id", { $handle: handle, $id: user.id });
  return handle;
}

/** TOTP + WebAuthn enrollment, mounted at /api/account/mfa. */
export function mfaRouter(state: AppState): Router {
  const router = Router();
  const { db } = state;

  router.get("/", requireSession(state), (req, res) => {
    const userId = req.sessionRow!.user_id;
    const rows = credentials.listForUser(db, userId);
    res.json({
      credentials: rows.map((c) => ({
        id: c.id,
        kind: c.kind,
        label: c.label,
        created_at: c.created_at,
        updated_at: c.updated_at,
      })),
    });
  });

  router.post("/totp/setup", requireSession(state), requireCsrf, (req, res) => {
    const user = db.get<UserRow>("SELECT * FROM users WHERE id = $id", { $id: req.sessionRow!.user_id })!;
    const secret = authenticator.generateSecret();
    const otpauthUrl = authenticator.keyuri(user.username, "FileUpload", secret);
    res.json({ secret, otpauth_url: otpauthUrl });
  });

  router.post("/totp/confirm", requireSession(state), requireCsrf, (req, res) => {
    const { secret, code, label } = req.body ?? {};
    if (typeof secret !== "string" || typeof code !== "string") {
      res.status(422).json({ detail: "secret and code required" });
      return;
    }
    const sessionKey = `mfa-setup:${req.sessionRow!.id}`;
    if (!state.lockout.checkLoginAllowed(db, sessionKey, sessionKey)) {
      res.status(429).json({ detail: "too many attempts, try again later" });
      return;
    }
    if (!authenticator.verify({ token: code, secret })) {
      state.lockout.recordFailure(db, sessionKey, "username");
      res.status(401).json({ detail: "invalid code" });
      return;
    }
    state.lockout.resetSuccess(db, sessionKey);
    const userId = req.sessionRow!.user_id;
    const encrypted = sealSecret(getMasterKey(state.settings), Buffer.from(secret));
    const id = credentials.createTotp(db, userId, encrypted, typeof label === "string" && label ? label : "Authenticator app");
    const enrolledUser = db.get<UserRow>("SELECT * FROM users WHERE id = $id", { $id: userId });
    recordAudit(db, {
      actor: enrolledUser?.username ?? String(userId),
      action: "mfa.totp_enrolled",
      target: `credential:${id}`,
      ip: clientIp(state, req),
    });
    res.json({ status: "enrolled", id });
  });

  router.post("/webauthn/register/start", requireSession(state), requireCsrf, async (req, res) => {
    const user = db.get<UserRow>("SELECT * FROM users WHERE id = $id", { $id: req.sessionRow!.user_id })!;
    let rpContext: { rpID: string; origin: string };
    try {
      rpContext = resolveRpContext(state.settings, req);
    } catch (err) {
      res.status(400).json({ detail: err instanceof Error ? err.message : "invalid origin" });
      return;
    }
    const userHandle = ensureWebauthnUserHandle(db, user);
    const existing = credentials.listForUser(db, user.id).filter((c) => c.kind === "webauthn" && c.webauthn_id);
    const options = await buildRegistrationOptions(
      rpContext,
      req.sessionRow!.id,
      userHandle,
      user.username,
      existing.map((c) => c.webauthn_id!),
    );
    res.json({ options });
  });

  router.post("/webauthn/register/finish", requireSession(state), requireCsrf, async (req, res) => {
    const { response, label } = req.body ?? {};
    if (!response || typeof response !== "object") {
      res.status(422).json({ detail: "response required" });
      return;
    }
    let rpContext: { rpID: string; origin: string };
    try {
      rpContext = resolveRpContext(state.settings, req);
    } catch (err) {
      res.status(400).json({ detail: err instanceof Error ? err.message : "invalid origin" });
      return;
    }
    const expectedChallenge = takeRegistrationChallenge(req.sessionRow!.id);
    if (!expectedChallenge) {
      res.status(400).json({ detail: "registration ceremony expired, try again" });
      return;
    }
    let verification;
    try {
      verification = await verifyRegistration(rpContext, response, expectedChallenge);
    } catch (err) {
      res.status(400).json({ detail: err instanceof Error ? err.message : "verification failed" });
      return;
    }
    if (!verification.verified || !verification.registrationInfo) {
      res.status(400).json({ detail: "verification failed" });
      return;
    }
    const { credential } = verification.registrationInfo;
    const userId = req.sessionRow!.user_id;
    const id = credentials.createWebauthn(
      db,
      userId,
      credential.id,
      Buffer.from(credential.publicKey),
      credential.transports ?? null,
      typeof label === "string" && label ? label : "Passkey",
    );
    const enrolledUser = db.get<UserRow>("SELECT * FROM users WHERE id = $id", { $id: userId });
    recordAudit(db, {
      actor: enrolledUser?.username ?? String(userId),
      action: "mfa.webauthn_enrolled",
      target: `credential:${id}`,
      ip: clientIp(state, req),
    });
    res.json({ status: "enrolled", id });
  });

  router.delete("/:id", requireSession(state), requireCsrf, async (req, res) => {
    const { current_password: currentPassword } = req.body ?? {};
    const sessionRow = req.sessionRow!;
    const user = db.get<UserRow>("SELECT * FROM users WHERE id = $id", { $id: sessionRow.user_id })!;
    if (typeof currentPassword !== "string" || !(await verifyPassword(currentPassword, user.password_hash))) {
      res.status(401).json({ detail: "invalid credentials" });
      return;
    }
    const id = Number(req.params.id);
    const ok = credentials.deleteCredential(db, user.id, id);
    if (!ok) {
      res.status(404).json({ detail: "credential not found" });
      return;
    }
    recordAudit(db, { actor: user.username, action: "mfa.credential_removed", target: `credential:${id}`, ip: clientIp(state, req) });
    res.json({ status: "removed" });
  });

  return router;
}
