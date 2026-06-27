import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { csrf, isLoggedIn, user } from "../lib/api";
import { AuthShell, InlineAlert } from "../components/AuthShell";
import { Button } from "../components/Button";
import { Field, Input } from "../components/primitives";

export function LoginPage() {
  const nav = useNavigate();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (isLoggedIn()) nav("/files", { replace: true });
  }, [nav]);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    setBusy(true);
    try {
      const resp = await fetch("/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username: username.trim(), password }),
        credentials: "same-origin",
      });
      if (resp.status === 429) return setError("Too many attempts — try again later.");
      if (resp.status === 401) return setError("Invalid username or password.");
      if (!resp.ok) {
        const d = await resp.json().catch(() => ({}));
        return setError(d.detail || "Login failed.");
      }
      const data = await resp.json();
      csrf.set(data.csrf_token);
      user.set({ username: username.trim(), role: "user" });

      if (data.must_change_credentials) {
        nav("/account/change", { replace: true });
      } else {
        const me = await fetch("/account/me", { credentials: "same-origin" });
        if (me.ok) user.set(await me.json());
        nav("/files", { replace: true });
      }
    } catch {
      setError("Network error — is the server running?");
    } finally {
      setBusy(false);
    }
  }

  return (
    <AuthShell
      title="Sign in"
      subtitle="Encrypted, expiring file dispatch"
      foot={
        <>
          Sessions are short-lived. Links can expire,
          <br />
          cap their downloads, and self-destruct.
        </>
      }
    >
      {error && <InlineAlert kind="error">{error}</InlineAlert>}
      <form onSubmit={onSubmit} className="space-y-4">
        <Field label="Username">
          <Input
            type="text"
            autoComplete="username"
            autoCapitalize="off"
            spellCheck={false}
            autoFocus
            value={username}
            onChange={(e) => setUsername(e.target.value)}
          />
        </Field>
        <Field label="Password">
          <Input
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        </Field>
        <Button type="submit" full disabled={busy} className="mt-2">
          {busy ? "Signing in…" : "Sign in"}
        </Button>
      </form>
    </AuthShell>
  );
}
