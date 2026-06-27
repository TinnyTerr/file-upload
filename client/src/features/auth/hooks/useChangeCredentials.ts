import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { ApiError, csrf, user } from "../../../lib/api";
import { changeCredentials, fetchMe } from "../services/authService";

type Alert = { kind: "error" | "success"; msg: string } | null;

/** State + orchestration for the credential-change form. */
export function useChangeCredentials() {
  const nav = useNavigate();
  const [current, setCurrent] = useState("");
  const [newUsername, setNewUsername] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [alert, setAlert] = useState<Alert>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!csrf.get()) {
      nav("/login", { replace: true });
      return;
    }
    const stored = user.get();
    if (stored?.username) setNewUsername(stored.username);
  }, [nav]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setAlert(null);

    if (!newUsername.trim()) return setAlert({ kind: "error", msg: "Username cannot be empty." });
    if (newPassword.length < 12)
      return setAlert({ kind: "error", msg: "Password must be at least 12 characters." });
    if (newPassword !== confirm) return setAlert({ kind: "error", msg: "Passwords do not match." });

    setBusy(true);
    try {
      await changeCredentials({
        currentPassword: current,
        newUsername: newUsername.trim(),
        newPassword,
      });
      const me = await fetchMe();
      if (me) user.set(me);
      setAlert({ kind: "success", msg: "Credentials updated — redirecting…" });
      setTimeout(() => nav("/files", { replace: true }), 800);
    } catch (err) {
      if (err instanceof ApiError && err.status === 409)
        setAlert({ kind: "error", msg: "Username is taken — choose another." });
      else if (err instanceof ApiError && err.status === 401)
        setAlert({ kind: "error", msg: "Current password is incorrect." });
      else if (err instanceof ApiError) setAlert({ kind: "error", msg: err.message });
      else setAlert({ kind: "error", msg: "Network error." });
    } finally {
      setBusy(false);
    }
  }

  return {
    current, setCurrent,
    newUsername, setNewUsername,
    newPassword, setNewPassword,
    confirm, setConfirm,
    alert, busy, submit,
  };
}
