import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { csrf, user, apiFetch } from '../lib/api.js';

export default function LoginPage() {
  const navigate = useNavigate();
  const [alert, setAlert] = useState(null);
  const [loading, setLoading] = useState(false);
  const usernameRef = useRef(null);

  useEffect(() => {
    if (csrf.get()) navigate("/files", { replace: true });
    else usernameRef.current?.focus();
  }, [navigate]);

  async function handleSubmit(e) {
    e.preventDefault();
    setAlert(null);
    setLoading(true);

    const username = e.target.username.value.trim();
    const password = e.target.password.value;

    try {
      const resp = await fetch("/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username, password }),
        credentials: "same-origin",
      });

      if (resp.status === 429) {
        setAlert("Too many attempts — try again later.");
        return;
      }
      if (resp.status === 401) {
        setAlert("Invalid username or password.");
        return;
      }
      if (!resp.ok) {
        const d = await resp.json().catch(() => ({}));
        setAlert(d.detail || "Login failed.");
        return;
      }

      const data = await resp.json();
      csrf.set(data.csrf_token);
      user.set({ username });

      if (data.must_change_credentials) {
        navigate("/account/change", { replace: true });
      } else {
        const me = await fetch("/account/me", { credentials: "same-origin" });
        if (me.ok) user.set(await me.json());
        navigate("/files", { replace: true });
      }
    } catch {
      setAlert("Network error — is the server running?");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="auth-wrap">
      <div className="auth-card">
        <div className="auth-logo">Oxymoron</div>
        <h1 className="auth-title">Sign in</h1>
        {alert && <div className="alert alert-error">{alert}</div>}
        <form onSubmit={handleSubmit}>
          <div className="form-group">
            <label htmlFor="username">Username</label>
            <input
              ref={usernameRef}
              id="username"
              name="username"
              type="text"
              autoComplete="username"
              required
            />
          </div>
          <div className="form-group">
            <label htmlFor="password">Password</label>
            <input
              id="password"
              name="password"
              type="password"
              autoComplete="current-password"
              required
            />
          </div>
          <button
            type="submit"
            id="submit-btn"
            className="btn btn-primary btn-block"
            disabled={loading}
          >
            {loading ? "Signing in…" : "Sign in"}
          </button>
        </form>
      </div>
    </div>
  );
}
