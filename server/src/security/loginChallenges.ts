import { randomBytes } from "node:crypto";
import type { WebSocket } from "ws";

export type LoginChallengeState = "connected" | "password_ok" | "awaiting_second_factor" | "done";

interface ChallengeEntry {
  state: LoginChallengeState;
  userId: number | null;
  expiresAt: number;
  ws: WebSocket | null;
  webauthnChallenge: string | null;
}

const TTL_MS = 5 * 60 * 1000;

const WS_TOKEN_WINDOW_MS = 60 * 1000;
const WS_TOKEN_MAX_PER_WINDOW = 20;

/** Simple fixed-window per-IP limiter for GET /auth/ws-token, so a client
 * can't exhaust the challenge Map by minting connIds in a loop. Deliberately
 * separate from LockoutPolicy (DB-backed, tied to failed-login semantics) --
 * this is just request-volume throttling on a cheap, unauthenticated route. */
export class WsTokenRateLimiter {
  private windows = new Map<string, { count: number; resetAt: number }>();

  /** Mirrors LoginChallengeRegistry.sweep() below -- without this, `windows`
   * grows without bound (one entry per distinct IP ever seen, never removed
   * once its window lapses). */
  private sweep(): void {
    const now = Date.now();
    for (const [ip, entry] of this.windows) {
      if (entry.resetAt <= now) this.windows.delete(ip);
    }
  }

  allow(ip: string): boolean {
    this.sweep();
    const now = Date.now();
    const entry = this.windows.get(ip);
    if (!entry || entry.resetAt <= now) {
      this.windows.set(ip, { count: 1, resetAt: now + WS_TOKEN_WINDOW_MS });
      return true;
    }
    if (entry.count >= WS_TOKEN_MAX_PER_WINDOW) return false;
    entry.count += 1;
    return true;
  }
}

/** In-memory pending-login registry backing the pre-login /api/auth
 * websocket, modeled on HaltRegistry (cluster/halt.ts): single process,
 * TTL'd Map, no persistence -- a restart mid-login just forces a retry.
 *
 * connId is a UX/transport correlation id ONLY, never proof of
 * authentication -- it gates which pushed messages a socket receives and
 * which WebAuthn challenge to verify against. Real auth is always the
 * password hash, TOTP code, or WebAuthn signature. A future QR/cross-device
 * approval flow can reuse this same connId/registry without protocol
 * changes -- it would just add a new transition source. */
export class LoginChallengeRegistry {
  private challenges = new Map<string, ChallengeEntry>();

  private sweep(): void {
    const now = Date.now();
    for (const [id, entry] of this.challenges) {
      if (entry.expiresAt <= now) this.challenges.delete(id);
    }
  }

  create(): string {
    this.sweep();
    const connId = randomBytes(16).toString("base64url");
    this.challenges.set(connId, {
      state: "connected",
      userId: null,
      expiresAt: Date.now() + TTL_MS,
      ws: null,
      webauthnChallenge: null,
    });
    return connId;
  }

  get(connId: string): ChallengeEntry | undefined {
    this.sweep();
    return this.challenges.get(connId);
  }

  attach(connId: string, ws: WebSocket): boolean {
    const entry = this.get(connId);
    if (!entry) return false;
    entry.ws = ws;
    return true;
  }

  detach(connId: string): void {
    const entry = this.challenges.get(connId);
    if (entry) entry.ws = null;
  }

  transition(connId: string, patch: Partial<Pick<ChallengeEntry, "state" | "userId" | "webauthnChallenge">>): void {
    const entry = this.get(connId);
    if (!entry) return;
    Object.assign(entry, patch);
    if (entry.ws && entry.ws.readyState === entry.ws.OPEN) {
      entry.ws.send(JSON.stringify({ type: "state", state: entry.state }));
    }
    if (entry.state === "done") this.challenges.delete(connId);
  }

  setWebauthnChallenge(connId: string, challenge: string): void {
    const entry = this.get(connId);
    if (entry) entry.webauthnChallenge = challenge;
  }

  /** Single-use: clears the stored challenge once read so it can't be replayed. */
  takeWebauthnChallenge(connId: string): string | null {
    const entry = this.get(connId);
    if (!entry) return null;
    const challenge = entry.webauthnChallenge;
    entry.webauthnChallenge = null;
    return challenge;
  }
}
