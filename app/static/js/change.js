import { csrf, user, apiFetch, showToast } from "./api.js";

if (!csrf.get()) location.replace("/login");

const form = document.getElementById("change-form");
const alertEl = document.getElementById("alert");
const submitBtn = document.getElementById("submit-btn");

// Pre-fill username if we have it
const stored = user.get();
if (stored && stored.username) {
  document.getElementById("new-username").value = stored.username;
}

function showAlert(msg, type = "error") {
  alertEl.textContent = msg;
  alertEl.className = `alert alert-${type}`;
}
function hideAlert() { alertEl.className = "alert hidden"; }

form.addEventListener("submit", async (e) => {
  e.preventDefault();
  hideAlert();

  const currentPassword = document.getElementById("current-password").value;
  const newUsername    = document.getElementById("new-username").value.trim();
  const newPassword    = document.getElementById("new-password").value;
  const confirmPassword = document.getElementById("confirm-password").value;

  if (!newUsername) { showAlert("Username cannot be empty."); return; }
  if (newPassword.length < 12) { showAlert("Password must be at least 12 characters."); return; }
  if (newPassword !== confirmPassword) { showAlert("Passwords do not match."); return; }

  submitBtn.disabled = true;
  submitBtn.textContent = "Updating…";

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

    // Refresh user info
    const me = await apiFetch("/account/me");
    if (me.ok) user.set(await me.json());

    showAlert("Credentials updated — redirecting…", "success");
    setTimeout(() => location.replace("/files"), 800);
  } catch {
    showAlert("Network error.");
  } finally {
    submitBtn.disabled = false;
    submitBtn.textContent = "Update credentials";
  }
});
