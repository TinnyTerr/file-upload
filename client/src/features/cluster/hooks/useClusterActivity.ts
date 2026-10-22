import { useEffect, useRef, useState } from "react";
import {
	type ActivityStore,
	applyMessage,
	emptyStore,
} from "../lib/activityStore";
import type { ActivityMessage } from "../types";

export type ActivityConn = "off" | "connecting" | "live" | "retrying";

const RENDER_MS = 250;
const RETRY_MS = 3000;

/** Opens the server's activity socket only while `enabled`. The server traces
 * nothing until a socket like this is subscribed, so the toggle is also the
 * cost switch. Messages fold into a ref; React re-renders on a fixed 250 ms
 * tick (which also drives countdowns) rather than once per message. */
export function useClusterActivity(enabled: boolean) {
	const store = useRef<ActivityStore>(emptyStore());
	const [conn, setConn] = useState<ActivityConn>("off");
	const [, setTick] = useState(0);

	useEffect(() => {
		if (!enabled) {
			setConn("off");
			return;
		}
		let cancelled = false;
		let ws: WebSocket | null = null;
		let retry: ReturnType<typeof setTimeout> | null = null;

		const open = () => {
			setConn((c) => (c === "retrying" ? c : "connecting"));
			const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
			ws = new WebSocket(
				`${proto}//${window.location.host}/api/ws/cluster-activity`,
			);
			ws.onmessage = (ev) => {
				try {
					applyMessage(store.current, JSON.parse(ev.data) as ActivityMessage);
					setConn("live");
				} catch {
					// ignore a malformed frame
				}
			};
			ws.onclose = () => {
				if (cancelled) return;
				setConn("retrying");
				retry = setTimeout(open, RETRY_MS);
			};
		};
		store.current = emptyStore();
		open();
		const render = setInterval(() => setTick((n) => n + 1), RENDER_MS);

		return () => {
			cancelled = true;
			if (retry) clearTimeout(retry);
			clearInterval(render);
			ws?.close();
		};
	}, [enabled]);

	return { store: store.current, conn };
}
