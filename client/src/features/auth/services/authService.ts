// Network boundary for authentication + account credential flows.
// Every call to /auth and /account lives here so the contract is reviewable
// in one place. Ported from app/static/js/login.js + change.js.

import { ApiError, apiFetch, csrf, readDetail, user, type User } from "../../../lib/api";

export interface LoginResult {
  csrfToken: string;
  mustChange: boolean;
}

/** POST /auth/login — establishes the session cookie + returns the CSRF token. */
export async function login(username: string, password: string): Promise<LoginResult> {
  const resp = await fetch("/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username, password }),
    credentials: "same-origin",
  });
  if (!resp.ok) throw new ApiError(resp.status, await readDetail(resp, "Login failed."));
  const data = await resp.json();
  return { csrfToken: data.csrf_token, mustChange: !!data.must_change_credentials };
}

/** GET /account/me — full profile + permission flags, or null if unavailable. */
export async function fetchMe(): Promise<User | null> {
  const resp = await apiFetch("/account/me");
  if (!resp.ok) return null;
  return (await resp.json()) as User;
}

/** POST /account/change-credentials — set a new username + password. */
export async function changeCredentials(input: {
  currentPassword: string;
  newUsername: string;
  newPassword: string;
}): Promise<void> {
  const resp = await apiFetch("/account/change-credentials", {
    method: "POST",
    json: {
      current_password: input.currentPassword,
      new_username: input.newUsername,
      new_password: input.newPassword,
    },
  });
  if (!resp.ok) throw new ApiError(resp.status, await readDetail(resp, "Update failed."));
}

/** Persist the session token + a best-effort user snapshot after login. */
export async function persistSession(username: string, mustChange: boolean): Promise<void> {
  // Provisional record; replaced by the full /account/me profile when available.
  user.set({ username, role: "user" });
  if (!mustChange) {
    const me = await fetchMe();
    if (me) user.set(me);
  }
}

export { csrf };
