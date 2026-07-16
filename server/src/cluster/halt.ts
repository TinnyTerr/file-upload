import type { EventBus } from "./eventBus.ts";

/** Process-wide registry of active upload halts with TTL expiry. Mirrors
 * app/cluster/halt.py.
 *
 * A halt is either cluster-wide ("global") or scoped to one user
 * ("user:<id>"). An over-quota upload halts that user first; an
 * over-total-disk / global-quota condition halts everyone. Producers (upload
 * paths) and the firehose consumer both touch the same instance (held on
 * AppState), so a halt raised on any node and gossiped over the firehose
 * pauses uploads everywhere until it expires. */

export const DEFAULT_HALT_TTL_SECONDS = 300;
export const GLOBAL_SCOPE = "global";

export function userScope(userId: number): string {
  return `user:${userId}`;
}

export class HaltRegistry {
  private halts = new Map<string, number>(); // scope -> expiry epoch ms

  reset(): void {
    this.halts.clear();
  }

  set(scope: string, untilEpochMs: number): void {
    const existing = this.halts.get(scope) ?? 0;
    // Never shorten an existing halt -- keep the furthest-out expiry.
    this.halts.set(scope, Math.max(existing, untilEpochMs));
  }

  setTtl(scope: string, ttlSeconds: number = DEFAULT_HALT_TTL_SECONDS): number {
    const until = Date.now() + ttlSeconds * 1000;
    this.set(scope, until);
    return until;
  }

  clear(scope: string): void {
    this.halts.delete(scope);
  }

  /** Latest expiry (epoch ms) of any halt currently affecting this user
   * (global, or their own scope), or null if uploads are allowed. */
  activeUntil(userId: number | null): number | null {
    const now = Date.now();
    for (const [scope, exp] of this.halts) {
      if (exp <= now) this.halts.delete(scope);
    }
    const candidates = [this.halts.get(GLOBAL_SCOPE) ?? 0];
    if (userId !== null) candidates.push(this.halts.get(userScope(userId)) ?? 0);
    const best = Math.max(...candidates);
    return best > now ? best : null;
  }

  snapshot(): Record<string, number> {
    const now = Date.now();
    const out: Record<string, number> = {};
    for (const [scope, exp] of this.halts) {
      if (exp > now) out[scope] = exp / 1000;
    }
    return out;
  }
}

/** Apply an `upload.halt` / `upload.resume` control event received from a
 * peer's firehose to the local registry. */
export function applyHaltEvent(registry: HaltRegistry, event: Record<string, unknown>): void {
  const scope = event.scope as string | undefined;
  if (!scope) return;
  if (event.action === "upload.resume") {
    registry.clear(scope);
    return;
  }
  const until = Number(event.until);
  if (Number.isFinite(until)) {
    registry.set(scope, until * 1000);
  } else {
    registry.setTtl(scope);
  }
}

/** Raise a halt locally and gossip it to peers over the firehose. Returns
 * the expiry epoch (seconds), matching the wire format used by
 * ClusterSelf.halts / apply_halt_event's `until`. */
export function broadcastHalt(
  registry: HaltRegistry,
  eventBus: EventBus,
  scope: string,
  opts: { ttlSeconds?: number; reason?: string } = {},
): number {
  const untilMs = registry.setTtl(scope, opts.ttlSeconds ?? DEFAULT_HALT_TTL_SECONDS);
  const untilSeconds = untilMs / 1000;
  try {
    eventBus.publish({
      action: "upload.halt",
      actor: "system",
      target: scope,
      kind: "control",
      scope,
      until: untilSeconds,
      reason: opts.reason ?? "",
    });
  } catch {
    // best-effort gossip -- never fail the halt itself
  }
  return untilSeconds;
}
