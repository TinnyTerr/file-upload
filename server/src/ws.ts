import { timingSafeEqual } from "node:crypto";
import type { Server as HttpServer, IncomingMessage } from "node:http";
import type { Request } from "express";
import { type WebSocket, WebSocketServer } from "ws";
import type { AppState } from "./appState.ts";
import type { ClusterEvent, EventPredicate } from "./cluster/eventBus.ts";
import type { UserRow } from "./db/rows.ts";
import { getLogger } from "./logging.ts";
import { clientIp } from "./middleware/auth.ts";
import { COOKIE_NAME } from "./security/sessions.ts";

/** Realtime event firehose. Mirrors app/routes/ws.py, adapted from FastAPI's
 * native WebSocket support to the `ws` package attached to Express's raw
 * http.Server (Express itself has no websocket support -- see index.ts,
 * which captures app.listen()'s return value and passes it here).
 *
 * Three endpoints:
 *  - GET /api/ws/events -- per-user live stream, authenticated by the
 *    session cookie. A master receives every event; a regular user only
 *    their own (actor === username).
 *  - GET /api/admin/cluster/firehose -- the full, password-independent
 *    firehose for cluster nodes and external monitoring, authenticated by
 *    the cluster token (?token= or Authorization: Bearer).
 *  - GET /api/auth -- pre-login, opened by the /login page before any
 *    credentials exist. Authenticated by a short-lived conn_id minted via
 *    GET /api/auth/ws-token (see routes/auth.ts and security/loginChallenges.ts);
 *    pushes real-time login-state transitions during a login attempt. */

const log = getLogger("app.ws");

/** The upgrade handler gets a raw `IncomingMessage`, not an Express `Request`,
 * so `clientIp` can't be called directly. The shim gives it the two things it
 * touches -- `header()` and `socket` -- rather than duplicating the
 * proxy-header trust rules here, where they would drift. */
function peerIp(state: AppState, req: IncomingMessage): string {
	const shim = {
		header(name: string): string | undefined {
			const value = req.headers[name.toLowerCase()];
			return Array.isArray(value) ? value[0] : value;
		},
		socket: req.socket,
	};
	return clientIp(state, shim as unknown as Request) || "unknown";
}

/** Logs the connection's lifetime once it closes, so a socket that opens and
 * immediately drops is distinguishable from one that stayed up. */
function logConnection(ws: WebSocket, path: string, who: string): void {
	const openedAt = Date.now();
	log.info(`websocket open ${path} ${who}`);
	ws.on("close", (code: number) => {
		const seconds = ((Date.now() - openedAt) / 1000).toFixed(1);
		log.info(`websocket close ${path} ${who} code=${code} after ${seconds}s`);
	});
	ws.on("error", (err: Error) => {
		log.warning(`websocket error ${path} ${who}: ${err.message}`);
	});
}

/** A refused upgrade is logged at WARNING: it is either a misconfigured client
 * or someone probing the endpoints, and neither should need DEBUG to see. */
function rejectUpgrade(
	socket: { destroy(): void },
	path: string,
	ip: string,
	reason: string,
): void {
	log.warning(`websocket rejected ${path} ip=${ip}: ${reason}`);
	socket.destroy();
}

function parseCookies(header: string | undefined): Record<string, string> {
	const out: Record<string, string> = {};
	if (!header) return out;
	for (const part of header.split(";")) {
		const idx = part.indexOf("=");
		if (idx === -1) continue;
		const key = part.slice(0, idx).trim();
		const value = part.slice(idx + 1).trim();
		if (key) out[key] = decodeURIComponent(value);
	}
	return out;
}

function afterId(url: URL): number {
	const raw = url.searchParams.get("after");
	const n = Number(raw ?? "0");
	return Number.isFinite(n) ? n : 0;
}

/** Replays buffered events newer than afterId, then forwards live events
 * until the socket closes. */
function pump(
	state: AppState,
	ws: WebSocket,
	predicate: EventPredicate,
	after: number,
): void {
	for (const event of state.eventBus.recent({ afterId: after, predicate })) {
		ws.send(JSON.stringify({ type: "event", ...event }));
	}
	ws.send(
		JSON.stringify({ type: "ready", buffered: state.eventBus.subscriberCount }),
	);

	const unsubscribe = state.eventBus.subscribe(
		predicate,
		(event: ClusterEvent) => {
			if (ws.readyState === ws.OPEN) {
				ws.send(JSON.stringify({ type: "event", ...event }));
			}
		},
	);
	ws.on("close", unsubscribe);
	ws.on("error", unsubscribe);
}

/** Whether a handshake's `Origin` names the host the request arrived at. */
function sameHost(origin: string, host: string | undefined): boolean {
	if (!host) return false;
	try {
		return new URL(origin).host.toLowerCase() === host.toLowerCase();
	} catch {
		return false;
	}
}

function safeTokenEqual(presented: string, expected: string): boolean {
	const a = Buffer.from(presented);
	const b = Buffer.from(expected);
	return (
		!!presented && !!expected && a.length === b.length && timingSafeEqual(a, b)
	);
}

export function setupWebSockets(server: HttpServer, state: AppState): void {
	const userWss = new WebSocketServer({ noServer: true });
	const firehoseWss = new WebSocketServer({ noServer: true });
	const authWss = new WebSocketServer({ noServer: true });

	server.on("upgrade", (req: IncomingMessage, socket, head) => {
		const url = new URL(req.url ?? "/", "http://internal");
		const path = url.pathname;
		const ip = peerIp(state, req);

		// The cookie-authenticated sockets take the same cross-site stance as
		// the cookie itself (SameSite=strict): a browser handshake from another
		// origin is refused outright rather than relying on the cookie being
		// withheld. Non-browser clients send no Origin and are unaffected; the
		// cluster firehose is token-authenticated and exempt.
		if (path === "/api/ws/events" || path === "/api/auth") {
			const origin = req.headers.origin;
			if (origin && !sameHost(origin, req.headers.host)) {
				rejectUpgrade(
					socket,
					path,
					ip,
					`cross-origin handshake from ${origin}`,
				);
				return;
			}
		}

		if (path === "/api/ws/events") {
			const cookies = parseCookies(req.headers.cookie);
			const sessionRow = state.sessionManager.resolve(
				state.db,
				cookies[COOKIE_NAME],
			);
			if (!sessionRow) {
				rejectUpgrade(socket, path, ip, "no valid session cookie");
				return;
			}
			const user = state.db.get<UserRow>("SELECT * FROM users WHERE id = $id", {
				$id: sessionRow.user_id,
			});
			if (!user || user.must_change_credentials) {
				rejectUpgrade(
					socket,
					path,
					ip,
					user ? "account must change credentials" : "session user is gone",
				);
				return;
			}
			userWss.handleUpgrade(req, socket, head, (ws) => {
				logConnection(ws, path, `user=${user.username} ip=${ip}`);
				const predicate: EventPredicate =
					user.role === "master"
						? () => true
						: (e) => e.actor === user.username;
				pump(state, ws, predicate, afterId(url));
			});
			return;
		}

		if (path === "/api/admin/cluster/firehose") {
			let presented = url.searchParams.get("token") ?? "";
			if (!presented) {
				const header = req.headers.authorization ?? "";
				presented = header.startsWith("Bearer ")
					? header.slice("Bearer ".length).trim()
					: "";
			}
			if (!safeTokenEqual(presented, state.clusterToken)) {
				rejectUpgrade(
					socket,
					path,
					ip,
					presented ? "cluster token mismatch" : "no cluster token presented",
				);
				return;
			}
			firehoseWss.handleUpgrade(req, socket, head, (ws) => {
				logConnection(ws, path, `cluster-token ip=${ip}`);
				pump(state, ws, () => true, afterId(url));
			});
			return;
		}

		if (path === "/api/auth") {
			const connId = url.searchParams.get("conn_id") ?? "";
			const entry = state.loginChallenges.get(connId);
			if (!entry) {
				rejectUpgrade(
					socket,
					path,
					ip,
					connId ? "unknown or expired conn_id" : "no conn_id",
				);
				return;
			}
			authWss.handleUpgrade(req, socket, head, (ws) => {
				// conn_id is a transport correlation id, not a credential, so it
				// is safe in the log -- and it is the only handle a pre-login
				// socket has.
				logConnection(ws, path, `conn_id=${connId} ip=${ip}`);
				state.loginChallenges.attach(connId, ws);
				ws.send(JSON.stringify({ type: "ready", state: entry.state }));
				ws.on("close", () => state.loginChallenges.detach(connId));
			});
			return;
		}

		rejectUpgrade(socket, path, ip, "no websocket route at this path");
	});

	log.info(
		"websocket routes attached: /api/ws/events, /api/admin/cluster/firehose, /api/auth",
	);
}
