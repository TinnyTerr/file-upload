import { randomBytes } from "node:crypto";

interface TicketEntry {
  userId: number;
  attempts: number;
  expiresAt: number;
}

const TTL_MS = 2 * 60 * 1000;
const MAX_ATTEMPTS = 5;

/** Single-use tickets bridging "password verified" -> "second factor
 * verified" during login. In-memory, single-process, modeled on
 * LoginChallengeRegistry -- a ticket is never proof of authentication by
 * itself, only a handle for the pending attempt. */
export class SecondFactorTicketRegistry {
  private tickets = new Map<string, TicketEntry>();

  private sweep(): void {
    const now = Date.now();
    for (const [id, entry] of this.tickets) {
      if (entry.expiresAt <= now) this.tickets.delete(id);
    }
  }

  create(userId: number): string {
    this.sweep();
    const ticket = randomBytes(24).toString("base64url");
    this.tickets.set(ticket, { userId, attempts: 0, expiresAt: Date.now() + TTL_MS });
    return ticket;
  }

  /** Returns the bound userId if the ticket is valid and under its attempt
   * cap, recording this as an attempt regardless of what the caller does
   * with the result -- callers must not retry a failed verification against
   * the same ticket without this counting against them. */
  consumeAttempt(ticket: string): number | null {
    this.sweep();
    const entry = this.tickets.get(ticket);
    if (!entry) return null;
    entry.attempts += 1;
    if (entry.attempts > MAX_ATTEMPTS) {
      this.tickets.delete(ticket);
      return null;
    }
    return entry.userId;
  }

  destroy(ticket: string): void {
    this.tickets.delete(ticket);
  }
}
