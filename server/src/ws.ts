import { timingSafeEqual } from "node:crypto";
import type { Server as HttpServer, IncomingMessage } from "node:http";
import { type WebSocket, WebSocketServer } from "ws";
import type { AppState } from "./appState.ts";
import type { ClusterEvent, EventPredicate } from "./cluster/eventBus.ts";
import type { UserRow } from "./db/rows.ts";
import { getLogger } from "./logging.ts";
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

		if (url.pathname === "/api/ws/events") {
			const cookies = parseCookies(req.headers.cookie);
			const sessionRow = state.sessionManager.resolve(
				state.db,
				cookies[COOKIE_NAME],
			);
			if (!sessionRow) {
				socket.destroy();
				return;
			}
			const user = state.db.get<UserRow>("SELECT * FROM users WHERE id = $id", {
				$id: sessionRow.user_id,
			});
			if (!user || user.must_change_credentials) {
				socket.destroy();
				return;
			}
			userWss.handleUpgrade(req, socket, head, (ws) => {
				const predicate: EventPredicate =
					user.role === "master"
						? () => true
						: (e) => e.actor === user.username;
				pump(state, ws, predicate, afterId(url));
			});
			return;
		}

		if (url.pathname === "/api/admin/cluster/firehose") {
			let presented = url.searchParams.get("token") ?? "";
			if (!presented) {
				const header = req.headers.authorization ?? "";
				presented = header.startsWith("Bearer ")
					? header.slice("Bearer ".length).trim()
					: "";
			}
			if (!safeTokenEqual(presented, state.clusterToken)) {
				socket.destroy();
				return;
			}
			firehoseWss.handleUpgrade(req, socket, head, (ws) => {
				pump(state, ws, () => true, afterId(url));
			});
			return;
		}

		if (url.pathname === "/api/auth") {
			const connId = url.searchParams.get("conn_id") ?? "";
			const entry = state.loginChallenges.get(connId);
			if (!entry) {
				socket.destroy();
				return;
			}
			authWss.handleUpgrade(req, socket, head, (ws) => {
				state.loginChallenges.attach(connId, ws);
				ws.send(JSON.stringify({ type: "ready", state: entry.state }));
				ws.on("close", () => state.loginChallenges.detach(connId));
			});
			return;
		}

		socket.destroy();
	});

	log.info(
		"websocket routes attached: /api/ws/events, /api/admin/cluster/firehose, /api/auth",
	);
}
