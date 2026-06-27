import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { apiFetch, csrf, user } from "../lib/api";
import { AuthShell, InlineAlert } from "../components/AuthShell";
import { Button } from "../components/Button";
import { Field, Input } from "../components/primitives";

export function ChangePage() {
  const nav = useNavigate();
  const [current, setCurrent] = useState("");
  const [newUsername, setNewUsername] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [alert, setAlert] = useState<{ kind: "error" | "success"; msg: string } | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!csrf.get()) {
      nav("/login", { replace: true });
      return;
    }
    const stored = user.get();
    if (stored?.username) setNewUsername(stored.username);
  }, [nav]);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setAlert(null);

    if (!newUsername.trim()) return setAlert({ kind: "error", msg: "Username cannot be empty." });
    if (newPassword.length < 12)
      return setAlert({ kind: "error", msg: "Password must be at least 12 characters." });
    if (newPassword !== confirm)
      return setAlert({ kind: "error", msg: "Passwords do not match." });

    setBusy(true);
    try {
      const resp = await apiFetch("/account/change-credentials", {
        method: "POST",
        json: {
          current_password: current,
          new_username: newUsername.trim(),
          new_password: newPassword,
        },
      });
      if (resp.status === 409)
        return setAlert({ kind: "error", msg: "Username is taken — choose another." });
      if (resp.status === 401)
        return setAlert({ kind: "error", msg: "Current password is incorrect." });
      if (!resp.ok) {
        const d = await resp.json().catch(() => ({}));
        return setAlert({ kind: "error", msg: d.detail || "Update failed." });
      }
      const me = await apiFetch("/account/me");
      if (me.ok) user.set(await me.json());
      setAlert({ kind: "success", msg: "Credentials updated — redirecting…" });
      setTimeout(() => nav("/files", { replace: true }), 800);
    } catch {
      setAlert({ kind: "error", msg: "Network error." });
    } finally {
      setBusy(false);
    }
  }

  return (
    <AuthShell title="Update credentials" subtitle="Set a new username and password to continue">
      {alert && <InlineAlert kind={alert.kind}>{alert.msg}</InlineAlert>}
      <form onSubmit={onSubmit} className="space-y-4">
        <Field label="Current password">
          <Input
            type="password"
            autoComplete="current-password"
            autoFocus
            value={current}
            onChange={(e) => setCurrent(e.target.value)}
          />
        </Field>
        <div className="h-px bg-[var(--color-line)]" />
        <Field label="New username">
          <Input
            type="text"
            autoCapitalize="off"
            spellCheck={false}
            value={newUsername}
            onChange={(e) => setNewUsername(e.target.value)}
          />
        </Field>
        <Field label="New password (min 12 chars)">
          <Input
            type="password"
            autoComplete="new-password"
            value={newPassword}
            onChange={(e) => setNewPassword(e.target.value)}
          />
        </Field>
        <Field label="Confirm password">
          <Input
            type="password"
            autoComplete="new-password"
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
          />
        </Field>
        <Button type="submit" full disabled={busy} className="mt-2">
          {busy ? "Updating…" : "Update credentials"}
        </Button>
      </form>
    </AuthShell>
  );
}
