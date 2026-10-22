import type { Request, Response } from "express";
import type { AppState } from "../appState.ts";
import { getLogger } from "../logging.ts";
import { clientIp } from "./auth.ts";

const log = getLogger("app.access");

/** Who the request claims to be, as far as it has been resolved so far. */
export function actorOf(req: Request): string {
	if (req.oauthToken) return `oauth:${req.oauthToken.id}`;
	if (req.apiKey) return `apikey:${req.apiKey.id}`;
	if (req.currentUser) return `user:${req.currentUser.username}`;
	if (req.sessionRow) return `session-user:${req.sessionRow.user_id}`;
	return "anonymous";
}

/** One line saying a request was refused and *why*. These go to the ring buffer
 * the admin Logs tab reads (and the console at WARNING), so the reason has to
 * say which check failed -- the status code alone never does. Never pass a
 * credential in `why`. */
export function logDeny(
	state: AppState,
	req: Request,
	status: number,
	why: string,
): void {
	const path = req.originalUrl.split("?")[0] ?? req.originalUrl;
	log.warning(
		`denied status=${status} why="${why}" method=${req.method} path=${path} actor=${actorOf(req)} ip=${clientIp(state, req)}`,
	);
}

/** Logs the refusal, then writes the usual `{detail}` response. */
export function deny(
	state: AppState,
	req: Request,
	res: Response,
	status: number,
	detail: string,
	why: string,
): void {
	logDeny(state, req, status, why);
	res.status(status).json({ detail });
}
