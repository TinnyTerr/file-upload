const CSRF_KEY = "fu_csrf";
const USER_KEY = "fu_user";

export const csrf = {
  get: () => localStorage.getItem(CSRF_KEY) || "",
  set: (t) => localStorage.setItem(CSRF_KEY, t),
  clear: () => localStorage.removeItem(CSRF_KEY),
};

export const user = {
  get: () => {
    try { return JSON.parse(localStorage.getItem(USER_KEY)); } catch { return null; }
  },
  set: (u) => localStorage.setItem(USER_KEY, JSON.stringify(u)),
  clear: () => localStorage.removeItem(USER_KEY),
};

export function isLoggedIn() {
  return !!csrf.get();
}

export async function apiFetch(url, opts = {}) {
  const headers = { ...opts.headers };
  const method = (opts.method || "GET").toUpperCase();
  if (method !== "GET" && method !== "HEAD") {
    const token = csrf.get();
    if (token) headers["X-CSRF-Token"] = token;
  }
  if (opts.json !== undefined) {
    headers["Content-Type"] = "application/json";
    opts = { ...opts, body: JSON.stringify(opts.json) };
    delete opts.json;
  }
  return fetch(url, { ...opts, method, headers, credentials: "same-origin" });
}

export function formatBytes(n) {
  if (n == null || n === undefined) return "–";
  if (n < 1024) return n + " B";
  if (n < 1048576) return (n / 1024).toFixed(1) + " KB";
  if (n < 1073741824) return (n / 1048576).toFixed(1) + " MB";
  return (n / 1073741824).toFixed(2) + " GB";
}

export function formatDate(iso) {
  if (!iso) return "–";
  return new Date(iso).toLocaleString();
}

export function parseSize(str) {
  if (!str || !str.trim()) return null;
  const s = str.trim().toUpperCase().replace(/\s+/g, "").replace(/,/g, "");
  const m = s.match(/^([\d.]+)\s*(B|KB|MB|GB|TB)?$/);
  if (!m) return null;
  const n = parseFloat(m[1]);
  if (isNaN(n) || n < 0) return null;
  const mult = { B: 1, KB: 1024, MB: 1048576, GB: 1073741824, TB: 1099511627776 };
  return Math.round(n * (mult[m[2] || "B"] || 1));
}

export function parseDuration(str) {
  if (!str || !str.trim()) return null;
  const s = str.trim().toLowerCase().replace(/\s+/g, "");
  if (/^\d+$/.test(s)) return parseInt(s, 10);
  const m = s.match(/^([\d.]+)(s|m|h|d|w)$/);
  if (!m) return null;
  const n = parseFloat(m[1]);
  if (isNaN(n) || n <= 0) return null;
  const mult = { s: 1, m: 60, h: 3600, d: 86400, w: 604800 };
  return Math.round(n * mult[m[2]]);
}

export async function logout() {
  await apiFetch("/auth/logout", { method: "POST" });
  csrf.clear();
  user.clear();
  window.location.replace("/login");
}
