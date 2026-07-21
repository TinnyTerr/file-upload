import { useEffect, useRef, useState } from "react";
import { authService } from "../services/authService";

type WsState = "connecting" | "open" | "closed";

/** Owns the pre-login /api/auth websocket lifecycle. This is a UX
 * accelerant only -- every login step's HTTP response is authoritative on
 * its own, so a blocked or flaky socket never breaks login. */
export function useLoginConnection() {
  const [connId, setConnId] = useState<string | null>(null);
  const [wsState, setWsState] = useState<WsState>("connecting");
  const wsRef = useRef<WebSocket | null>(null);

  useEffect(() => {
    let cancelled = false;

    authService
      .wsToken()
      .then(({ conn_id }) => {
        if (cancelled) return;
        setConnId(conn_id);
        const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
        const ws = new WebSocket(`${proto}//${window.location.host}/api/auth?conn_id=${conn_id}`);
        wsRef.current = ws;
        ws.onopen = () => !cancelled && setWsState("open");
        ws.onclose = () => !cancelled && setWsState("closed");
        ws.onerror = () => !cancelled && setWsState("closed");
      })
      .catch(() => {
        if (!cancelled) setWsState("closed");
      });

    return () => {
      cancelled = true;
      wsRef.current?.close();
    };
  }, []);

  return { connId, wsState };
}
