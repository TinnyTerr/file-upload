import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { csrf, user, apiFetch } from '../lib/api.js';

export default function ChangePage() {
  const navigate = useNavigate();
  const [alert, setAlert] = useState(null);
  const [alertType, setAlertType] = useState("error");
  const [loading, setLoading] = useState(false);
  const [username, setUsername] = useState("");

  useEffect(() => {
    if (!csrf.get()) { navigate("/login", { replace: true }); return; }
    const stored = user.get();
    if (stored?.username) setUsername(stored.username);
  }, [navigate]);

  function showAlert(msg, type = "error") {
    setAlert(msg);
    setAlertType(type);
  }

  async function handleSubmit(e) {
    e.preventDefault();
    setAlert(null);

    const currentPassword = e.target["current-password"].value;
    const newUsername = e.target["new-username"].value.trim();
    const newPassword = e.target["new-password"].value;
    const confirmPassword = e.target["confirm-password"].value;

    if (!newUsername) { showAlert("Username cannot be empty."); return; }
    if (newPassword.length < 12) { showAlert("Password must be at least 12 characters."); return; }
    if (newPassword !== confirmPassword) { showAlert("Passwords do not match."); return; }

    setLoading(true);
    try {
      const resp = await apiFetch("/account/change-credentials", {
        method: "POST",
        json: { current_password: currentPassword, new_username: newUsername, new_password: newPassword },
      });

      if (resp.status === 409) { showAlert("Username is taken — choose another."); return; }
      if (resp.status === 401) { showAlert("Current password is incorrect."); return; }
      if (!resp.ok) {
        const d = await resp.json().catch(() => ({}));
        showAlert(d.detail || "Update failed.");
        return;
      }

      const me = await apiFetch("/account/me");
      if (me.ok) user.set(await me.json());

      showAlert("Credentials updated — redirecting…", "success");
      setTimeout(() => navigate("/files", { replace: true }), 800);
    } catch {
      showAlert("Network error.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="auth-wrap">
      <div className="auth-card">
        <div className="auth-logo">Oxymoron</div>
        <h1 className="auth-title">Set your credentials</h1>
        <p className="auth-sub">You must change your credentials before continuing.</p>
        {alert && <div className={`alert alert-${alertType}`}>{alert}</div>}
        <form id="change-form" onSubmit={handleSubmit}>
          <div className="form-group">
            <label htmlFor="current-password">Current password</label>
            <input id="current-password" name="current-password" type="password" required />
          </div>
          <div className="form-group">
            <label htmlFor="new-username">New username</label>
            <input
              id="new-username"
              name="new-username"
              type="text"
              value={username}
              onChange={e => setUsername(e.target.value)}
              required
            />
          </div>
          <div className="form-group">
            <label htmlFor="new-password">New password</label>
            <input id="new-password" name="new-password" type="password" minLength={12} required />
          </div>
          <div className="form-group">
            <label htmlFor="confirm-password">Confirm new password</label>
            <input id="confirm-password" name="confirm-password" type="password" required />
          </div>
          <button
            type="submit"
            className="btn btn-primary btn-block"
            disabled={loading}
          >
            {loading ? "Updating…" : "Update credentials"}
          </button>
        </form>
      </div>
    </div>
  );
}
