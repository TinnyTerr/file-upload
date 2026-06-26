import { csrf, user, showToast } from "./api.js";

// Already logged in → go to files
if (csrf.get()) location.replace("/files");

const form = document.getElementById("login-form");
const alertEl = document.getElementById("alert");
const submitBtn = document.getElementById("submit-btn");

function showAlert(msg) {
  alertEl.textContent = msg;
  alertEl.className = "alert alert-error";
}
function hideAlert() { alertEl.className = "alert hidden"; }

form.addEventListener("submit", async (e) => {
  e.preventDefault();
  hideAlert();
  submitBtn.disabled = true;
  submitBtn.textContent = "Signing in…";

  const username = document.getElementById("username").value.trim();
  const password = document.getElementById("password").value;

  try {
    const resp = await fetch("/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username, password }),
      credentials: "same-origin",
    });

    if (resp.status === 429) {
      showAlert("Too many attempts — try again later.");
      return;
    }
    if (resp.status === 401) {
      showAlert("Invalid username or password.");
      return;
    }
    if (!resp.ok) {
      const d = await resp.json().catch(() => ({}));
      showAlert(d.detail || "Login failed.");
      return;
    }

    const data = await resp.json();
    csrf.set(data.csrf_token);
    user.set({ username });

    if (data.must_change_credentials) {
      location.replace("/account/change");
    } else {
      // Fetch full user info
      const me = await fetch("/account/me", { credentials: "same-origin" });
      if (me.ok) user.set(await me.json());
      location.replace("/files");
    }
  } catch {
    showAlert("Network error — is the server running?");
  } finally {
    submitBtn.disabled = false;
    submitBtn.textContent = "Sign in";
  }
});
