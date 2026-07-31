import {
	createContext,
	type ReactNode,
	useCallback,
	useContext,
	useEffect,
	useState,
} from "react";
import { SealKeyDialog } from "../components/SealKeyDialog";

/** A secret that exists nowhere else. Sealing discards the server's copy before
 * the response is written; an end-to-end conversion never gives the server one
 * at all. Losing this object loses the file. */
export interface RevealedKey {
	/** Queue identity, and what the dialog is keyed on. */
	id: string;
	/** What the key opens — “photo.jpg”, or “5 files in Photos”. */
	subject: string;
	key: string;
	/** Derived from a password the user chose, rather than random. */
	isPassword: boolean;
	/** Why there is no second copy. Differs between a seal and an E2E convert. */
	reason: string;
	/** The e2e-conversion commit failed: the replaced original is still there. */
	incomplete?: boolean;
	/** What this key opens, so a later share modal can complete its URL. */
	refs?: KeyRef[];
	createdAt: number;
}

export interface KeyRef {
	kind: "file" | "folder";
	id: number;
}

interface RevealedKeyState {
	pending: RevealedKey[];
	/** Queue a key for display. Never silently dropped. */
	reveal: (k: Omit<RevealedKey, "id" | "createdAt">) => void;
	/** Called only from the dialog's "I've saved it" — never on unmount. */
	dismiss: (id: string) => void;
	/** A key this tab genuinely holds for a node, or null. */
	keyFor: (kind: KeyRef["kind"], id: number) => string | null;
	remember: (kind: KeyRef["kind"], id: number, keyB64: string) => void;
	forget: (kind: KeyRef["kind"], id: number) => void;
}

const PENDING_STORAGE = "fu_pending_keys@v1";
const HELD_STORAGE = "fu_held_keys@v1";

/**
 * `sessionStorage`, deliberately — do not "upgrade" this to `localStorage`.
 *
 * A reload in the middle of a seal must not destroy the only copy of the key,
 * which is why it is persisted at all. But the key is already on screen and in
 * the user's clipboard; writing it somewhere that outlives the browser session
 * would create a new at-rest secret nobody asked for, on a machine that may not
 * be the user's. Session scope is the smallest window that fixes the bug.
 */
function loadJson<T>(storageKey: string, fallback: T): T {
	try {
		const raw = sessionStorage.getItem(storageKey);
		return raw ? (JSON.parse(raw) as T) : fallback;
	} catch {
		return fallback;
	}
}

function saveJson(storageKey: string, value: unknown) {
	try {
		sessionStorage.setItem(storageKey, JSON.stringify(value));
	} catch {
		// Private-mode quota failures must not take the reveal down with them:
		// the in-memory queue is still authoritative for this page view.
	}
}

const refKey = (kind: KeyRef["kind"], id: number) => `${kind}:${id}`;

let seq = 0;

const RevealedKeyContext = createContext<RevealedKeyState | null>(null);

/**
 * The vault for keys the server cannot reproduce.
 *
 * This lives at the app root rather than inside the encryption panel for one
 * concrete reason: the mutations that *produce* these keys also change the
 * listing the panel is rendered from. An end-to-end conversion deletes the old
 * file, the drive refetches, the panel's item disappears, and any dialog owned
 * by that panel is unmounted — taking the key with it, milliseconds after it
 * was shown. Nothing routed can own this state.
 */
export function RevealedKeyProvider({ children }: { children: ReactNode }) {
	const [pending, setPending] = useState<RevealedKey[]>(() =>
		loadJson<RevealedKey[]>(PENDING_STORAGE, []),
	);
	const [held, setHeld] = useState<Record<string, string>>(() =>
		loadJson<Record<string, string>>(HELD_STORAGE, {}),
	);

	useEffect(() => saveJson(PENDING_STORAGE, pending), [pending]);
	useEffect(() => saveJson(HELD_STORAGE, held), [held]);

	// Closing the tab with a key still on screen loses it permanently, so make
	// the browser ask. This is the one place in the app where that is warranted.
	useEffect(() => {
		if (!pending.length) return;
		const onBeforeUnload = (e: BeforeUnloadEvent) => e.preventDefault();
		window.addEventListener("beforeunload", onBeforeUnload);
		return () => window.removeEventListener("beforeunload", onBeforeUnload);
	}, [pending.length]);

	const remember = useCallback(
		(kind: KeyRef["kind"], id: number, keyB64: string) =>
			setHeld((prev) => ({ ...prev, [refKey(kind, id)]: keyB64 })),
		[],
	);

	const forget = useCallback((kind: KeyRef["kind"], id: number) => {
		setHeld((prev) => {
			const next = { ...prev };
			delete next[refKey(kind, id)];
			return next;
		});
	}, []);

	const keyFor = useCallback(
		(kind: KeyRef["kind"], id: number) => held[refKey(kind, id)] ?? null,
		[held],
	);

	const reveal = useCallback((k: Omit<RevealedKey, "id" | "createdAt">) => {
		const entry: RevealedKey = {
			...k,
			id: `rk${++seq}`,
			createdAt: Date.now(),
		};
		setPending((prev) => [...prev, entry]);
		// A revealed key is by definition one the browser now holds, so the share
		// modal can complete a `#ek=` URL for the rest of this tab's lifetime.
		// A password-derived key is excluded: it's the user's own secret, not
		// something to cache and paste into a URL on their behalf.
		const refs = k.refs;
		if (!k.isPassword && refs?.length) {
			setHeld((prev) => {
				const next = { ...prev };
				for (const ref of refs) next[refKey(ref.kind, ref.id)] = k.key;
				return next;
			});
		}
	}, []);

	const dismiss = useCallback(
		(id: string) => setPending((prev) => prev.filter((k) => k.id !== id)),
		[],
	);

	const current = pending[0] ?? null;

	return (
		<RevealedKeyContext.Provider
			value={{ pending, reveal, dismiss, keyFor, remember, forget }}
		>
			{children}
			{/* `key` is load-bearing: SealKeyDialog holds the retype confirmation in
			    local state, so without a remount the second queued key would inherit
			    the first one's typed text and be dismissible with a stale value. */}
			<SealKeyDialog
				key={current?.id ?? "none"}
				revealed={current}
				onClose={() => current && dismiss(current.id)}
			/>
		</RevealedKeyContext.Provider>
	);
}

export function useRevealedKeys() {
	const ctx = useContext(RevealedKeyContext);
	if (!ctx)
		throw new Error("useRevealedKeys must be used within RevealedKeyProvider");
	return ctx;
}
