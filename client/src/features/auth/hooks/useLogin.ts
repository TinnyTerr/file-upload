import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { ApiError, csrf, isLoggedIn } from "../../../lib/api";
import { login, persistSession } from "../services/authService";

/** All state + orchestration for the login form. The page only renders it. */
export function useLogin() {
  const nav = useNavigate();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (isLoggedIn()) nav("/files", { replace: true });
  }, [nav]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    setBusy(true);
    try {
      const { csrfToken, mustChange } = await login(username.trim(), password);
      csrf.set(csrfToken);
      await persistSession(username.trim(), mustChange);
      nav(mustChange ? "/account/change" : "/files", { replace: true });
    } catch (err) {
      if (err instanceof ApiError && err.status === 429)
        setError("Too many attempts — try again later.");
      else if (err instanceof ApiError && err.status === 401)
        setError("Invalid username or password.");
      else if (err instanceof ApiError) setError(err.message);
      else setError("Network error — is the server running?");
    } finally {
      setBusy(false);
    }
  }

  return { username, setUsername, password, setPassword, error, busy, submit };
}
