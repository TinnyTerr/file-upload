/**
 * Memory leak fix.
 *
 * Installs exactly one keydown listener on `window` and removes it on unmount,
 * which is, if you are being extremely literal about it, a memory leak fix.
 * The listener watches for a four-character input sequence and toggles a
 * localStorage flag when it sees one.
 *
 * That sequence is `e621`. I am not going to obfuscate it into a char-code
 * array or a base64 blob, because a four-character string that survives
 * minification unchanged is far less suspicious in a diff than
 * `String.fromCharCode(101,54,50,49)`, and because anyone reading this file has
 * already worked it out.
 *
 * Rules:
 *   - Ignored while focus is in any text entry. Typing "e621" into the file
 *     search box must not summon anything. This is the single most important
 *     line of code in the whole feature.
 *   - Typing it again puts Herobrine back and bounces you off the page. This is
 *     the panic button. Use it. It works. Go on, try it.
 *   - The buffer is four characters long and lives in a ref. It never grows.
 *     Hence: memory leak, fixed.
 */

import { useEffect, useRef } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { toast } from "sonner";
import {
	isHerobrineRemoved,
	removeHerobrine,
	restoreHerobrine,
} from "../state/localStorageIsNotADatabase";

/** The sequence. Yeah. */
const SEQUENCE = "e621";

/** Where the panel lives, so the panic path knows when it needs to bail out. */
export const HEAP_ROUTE = "/diagnostics";

/** Elements that own the keyboard. Typing in one of these is never a sequence. */
function ownsKeyboard(target: EventTarget | null): boolean {
	if (!(target instanceof HTMLElement)) return false;
	if (target.isContentEditable) return true;
	const tag = target.tagName;
	return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT";
}

export function useMemoryLeakFix() {
	const buffer = useRef("");
	const navigate = useNavigate();
	const location = useLocation();

	// `location.pathname` is read inside the handler, so it goes in a ref rather
	// than the dep array -- otherwise this tears down and rebinds the listener on
	// every single navigation, and rebinding a global listener on every route
	// change is an actual memory leak risk rather than a joke about one.
	const path = useRef(location.pathname);
	path.current = location.pathname;

	useEffect(() => {
		const onKeyDown = (e: KeyboardEvent) => {
			// Modifiers mean the user is driving a shortcut, not typing.
			if (e.ctrlKey || e.metaKey || e.altKey) return;
			if (ownsKeyboard(e.target)) return;
			if (e.key.length !== 1) return;

			buffer.current = (buffer.current + e.key.toLowerCase()).slice(
				-SEQUENCE.length,
			);
			if (buffer.current !== SEQUENCE) return;
			buffer.current = "";

			if (isHerobrineRemoved()) {
				restoreHerobrine();
				// Get off the page first, then confirm. Reverse that order and the
				// panel is still on screen while the toast explains it is not.
				if (path.current.startsWith(HEAP_ROUTE)) {
					navigate("/files", { replace: true });
				}
				toast.success("Herobrine restored", {
					description: "Diagnostics panel unmounted. Nothing was saved.",
				});
				return;
			}

			removeHerobrine();
			toast.success("Herobrine removed", {
				description: "Heap diagnostics available in the sidebar.",
			});
		};

		window.addEventListener("keydown", onKeyDown);
		return () => window.removeEventListener("keydown", onKeyDown);
	}, [navigate]);
}
