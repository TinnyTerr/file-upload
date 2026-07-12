import { Router } from "express";
import type { AppState } from "../appState.ts";
import { requireSession, clientIp } from "../middleware/auth.ts";
import { requireCsrf } from "../security/csrf.ts";
import { COOKIE_NAME, type SessionRow } from "../security/sessions.ts";
import { hashPassword, verifyPassword, verifyDummyPassword } from "../security/passwords.ts";
import { recordAudit } from "../audit.ts";

interface UserRow {
  id: number;
  username: string;
  password_hash: string;
  role: string;
  must_change_credentials: number;
}

/** Mirrors app/routes/auth.py -- login/logout/session listing/revocation,
 * matching status codes, cookie attrs, and CSRF header behavior exactly. */
export function authRouter(state: AppState): Router {
  const router = Router();
  const { db, sessionManager, lockout } = state;

  router.post("/login", async (req, res) => {
    const { username, password } = req.body ?? {};
    if (typeof username !== "string" || typeof password !== "string") {
      res.status(422).json({ detail: "username and password required" });
      return;
    }
    const ip = clientIp(state, req);

    if (!lockout.checkLoginAllowed(db, username, ip)) {
      recordAudit(db, { actor: username, action: "login.locked_out", ip });
      res.status(429).json({ detail: "too many attempts, try later" });
      return;
    }

    const user = db.get<UserRow>("SELECT * FROM users WHERE username = $username", { $username: username });

    const ok = user ? await verifyPassword(password, user.password_hash) : (await verifyDummyPassword(password), false);

    if (!user || !ok) {
      lockout.recordFailure(db, username, "username");
      lockout.recordFailure(db, ip, "ip");
      recordAudit(db, { actor: username, action: "login.failure", ip });
      res.status(401).json({ detail: "invalid credentials" });
      return;
    }

    lockout.resetSuccess(db, username);
    const { cookieValue, csrfToken } = sessionManager.create(db, user.id, {
      ip,
      userAgent: req.header("user-agent") ?? null,
    });
    recordAudit(db, { actor: String(user.id), action: "login.success", ip });

    res.cookie(COOKIE_NAME, cookieValue, sessionManager.cookieParams());
    res.json({ csrf_token: csrfToken, must_change_credentials: !!user.must_change_credentials });
  });

  router.post("/logout", requireSession(state), requireCsrf, (req, res) => {
    const cookieValue = req.cookies?.[COOKIE_NAME] as string | undefined;
    sessionManager.destroy(db, cookieValue);
    recordAudit(db, { actor: String(req.sessionRow!.user_id), action: "logout" });
    res.clearCookie(COOKIE_NAME, { path: "/" });
    res.json({ status: "logged_out" });
  });

  router.get("/sessions", requireSession(state), requireCsrf, (req, res) => {
    const current = req.sessionRow!;
    const rows = db.all<SessionRow>(
      "SELECT * FROM sessions WHERE user_id = $userId AND expires_at > $now",
      { $userId: current.user_id, $now: new Date().toISOString() },
    );
    res.json({
      sessions: rows.map((s) => ({
        id: s.id,
        ip_address: s.ip_address,
        user_agent: s.user_agent,
        created_at: s.created_at,
        last_seen_at: s.last_seen_at,
        expires_at: s.expires_at,
        is_current: s.id === current.id,
      })),
    });
  });

  router.delete("/sessions/:id", requireSession(state), requireCsrf, async (req, res) => {
    const { current_password: currentPassword } = req.body ?? {};
    const current = req.sessionRow!;
    const user = db.get<UserRow>("SELECT * FROM users WHERE id = $id", { $id: current.user_id })!;
    if (typeof currentPassword !== "string" || !(await verifyPassword(currentPassword, user.password_hash))) {
      res.status(401).json({ detail: "invalid credentials" });
      return;
    }
    const target = db.get<SessionRow>("SELECT * FROM sessions WHERE id = $id", { $id: req.params.id });
    if (!target || target.user_id !== current.user_id) {
      res.status(404).json({ detail: "session not found" });
      return;
    }
    db.run("DELETE FROM sessions WHERE id = $id", { $id: target.id });
    recordAudit(db, { actor: String(current.user_id), action: "session.revoked", target: target.id });
    res.json({ status: "revoked" });
  });

  router.delete("/sessions", requireSession(state), requireCsrf, async (req, res) => {
    const { current_password: currentPassword } = req.body ?? {};
    const current = req.sessionRow!;
    const user = db.get<UserRow>("SELECT * FROM users WHERE id = $id", { $id: current.user_id })!;
    if (typeof currentPassword !== "string" || !(await verifyPassword(currentPassword, user.password_hash))) {
      res.status(401).json({ detail: "invalid credentials" });
      return;
    }
    db.run("DELETE FROM sessions WHERE user_id = $userId", { $userId: current.user_id });
    recordAudit(db, { actor: String(current.user_id), action: "session.revoked_all" });
    res.clearCookie(COOKIE_NAME, { path: "/" });
    res.json({ status: "all_revoked" });
  });

  return router;
}
