import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { ApiError, errorMessage } from "@/config/api";
import { type DropboxLink, dropboxService } from "../services/dropboxService";

const STORAGE_KEY = "fu_active_dropbox";

export interface ActiveDropbox {
	token: string;
	expires_at: string;
	created_at: string;
}

function load(): ActiveDropbox | null {
	try {
		const raw = localStorage.getItem(STORAGE_KEY);
		return raw ? (JSON.parse(raw) as ActiveDropbox) : null;
	} catch {
		return null;
	}
}

function save(value: ActiveDropbox | null) {
	if (value) localStorage.setItem(STORAGE_KEY, JSON.stringify(value));
	else localStorage.removeItem(STORAGE_KEY);
}

/**
 * Tracks a single active dropbox link client-side. The backend has no
 * list/server-side cancel endpoint, so "one at a time" and "cancel" are enforced locally;
 * a used/expired link is auto-cleared by polling its status on mount.
 */
export function useDropboxManager() {
	const [active, setActive] = useState<ActiveDropbox | null>(() => load());
	const [creating, setCreating] = useState(false);

	// On mount, verify a stored link is still live; drop it if used/expired.
	useEffect(() => {
		const current = load();
		if (!current) return;
		dropboxService.info(current.token).catch((err) => {
			if (
				err instanceof ApiError &&
				(err.status === 404 || err.status === 410)
			) {
				save(null);
				setActive(null);
			}
		});
	}, []);

	const create = useCallback(async (expiresInSeconds: number) => {
		if (load()) {
			toast.error("You already have an active receive link", {
				description: "Cancel it before creating a new one.",
			});
			return;
		}
		setCreating(true);
		try {
			const res: DropboxLink = await dropboxService.create({
				expires_in_seconds: expiresInSeconds,
			});
			const next: ActiveDropbox = {
				token: res.token,
				expires_at: res.expires_at,
				created_at: new Date().toISOString(),
			};
			save(next);
			setActive(next);
			toast.success("Receive link created");
		} catch (err) {
			toast.error("Couldn't create receive link", {
				description: errorMessage(err),
			});
		} finally {
			setCreating(false);
		}
	}, []);

	const cancel = useCallback(async () => {
		const current = load();
		if (current) {
			try {
				await dropboxService.cancel(current.token);
			} catch {
				// Already used/expired/gone — still clear locally
			}
		}
		save(null);
		setActive(null);
		toast.success("Receive link cancelled");
	}, []);

	return { active, creating, create, cancel };
}
