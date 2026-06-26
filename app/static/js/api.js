const CSRF_KEY = "fu_csrf";
const USER_KEY = "fu_user";

export const csrf = {
  get: ()    => localStorage.getItem(CSRF_KEY) || "",
  set: (t)   => localStorage.setItem(CSRF_KEY, t),
  clear: ()  => localStorage.removeItem(CSRF_KEY),
};

export const user = {
  get: ()    => { try { return JSON.parse(localStorage.getItem(USER_KEY)); } catch { return null; } },
  set: (u)   => localStorage.setItem(USER_KEY, JSON.stringify(u)),
  clear: ()  => localStorage.removeItem(USER_KEY),
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

/** Parse "10GB", "500 MB", "2.5tb" → bytes, or null on failure */
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

/** Parse "30s", "5m", "24h", "7d", "2w", or plain number (seconds) → seconds, or null */
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

let _toastContainer = null;
function toastContainer() {
  if (!_toastContainer) {
    _toastContainer = document.createElement("div");
    _toastContainer.className = "toast-container";
    document.body.appendChild(_toastContainer);
  }
  return _toastContainer;
}

export function showToast(msg, type = "success") {
  const t = document.createElement("div");
  t.className = `toast ${type}`;
  t.textContent = msg;
  toastContainer().appendChild(t);
  setTimeout(() => {
    t.classList.add("leaving");
    setTimeout(() => t.remove(), 260);
  }, 3500);
}

// ── Custom dialogs ─────────────────────────────────────────────────────────
// Replace native alert/confirm/prompt with themed, animated modals. Each returns
// a Promise that settles when the user acts (and never rejects).

function _buildDialog({ title, message, glyph, glyphKind, fields, buttons }) {
  const overlay = document.createElement("div");
  overlay.className = "modal-overlay";

  const modal = document.createElement("div");
  modal.className = "modal dialog";
  modal.setAttribute("role", "dialog");
  modal.setAttribute("aria-modal", "true");

  const head = document.createElement("div");
  head.className = "dialog-head";

  if (glyph) {
    const g = document.createElement("div");
    g.className = "dialog-glyph" + (glyphKind ? " " + glyphKind : "");
    g.textContent = glyph;
    head.appendChild(g);
  }

  const textWrap = document.createElement("div");
  textWrap.style.flex = "1";
  textWrap.style.minWidth = "0";
  if (title) {
    const t = document.createElement("div");
    t.className = "modal-title";
    t.textContent = title;
    textWrap.appendChild(t);
  }
  if (message) {
    const m = document.createElement("div");
    m.className = "dialog-msg";
    m.textContent = message;
    textWrap.appendChild(m);
  }
  head.appendChild(textWrap);
  modal.appendChild(head);

  const inputs = [];
  if (fields && fields.length) {
    for (const f of fields) {
      const grp = document.createElement("div");
      grp.className = "dialog-input";
      if (f.label) {
        const lbl = document.createElement("label");
        lbl.textContent = f.label;
        grp.appendChild(lbl);
      }
      const input = document.createElement("input");
      input.type = f.type || "text";
      if (f.placeholder) input.placeholder = f.placeholder;
      if (f.value) input.value = f.value;
      grp.appendChild(input);
      modal.appendChild(grp);
      inputs.push(input);
    }
  }

  const footer = document.createElement("div");
  footer.className = "modal-footer";
  modal.appendChild(footer);

  overlay.appendChild(modal);
  return { overlay, modal, footer, inputs };
}

function _closeDialog(overlay) {
  overlay.classList.add("closing");
  setTimeout(() => overlay.remove(), 170);
}

function _showDialog(spec) {
  return new Promise((resolve) => {
    const { overlay, footer, inputs } = _buildDialog(spec);
    let settled = false;
    const finish = (val) => {
      if (settled) return;
      settled = true;
      document.removeEventListener("keydown", onKey);
      _closeDialog(overlay);
      resolve(val);
    };

    for (const b of spec.buttons) {
      const btn = document.createElement("button");
      btn.className = "btn " + (b.kind || "btn-ghost");
      btn.textContent = b.label;
      btn.addEventListener("click", () => finish(typeof b.value === "function" ? b.value(inputs) : b.value));
      footer.appendChild(btn);
      if (b.primary) btn._primary = true;
    }

    function onKey(e) {
      if (e.key === "Escape") { e.preventDefault(); finish(spec.cancelValue); }
      else if (e.key === "Enter" && (!inputs.length || document.activeElement?.tagName === "INPUT")) {
        const primary = spec.buttons.find(b => b.primary);
        if (primary) { e.preventDefault(); finish(typeof primary.value === "function" ? primary.value(inputs) : primary.value); }
      }
    }
    document.addEventListener("keydown", onKey);
    overlay.addEventListener("mousedown", (e) => { if (e.target === overlay) finish(spec.cancelValue); });

    document.body.appendChild(overlay);
    requestAnimationFrame(() => (inputs[0] || footer.querySelector(".btn-primary,.btn-danger,.btn") || footer.lastChild)?.focus());
  });
}

export function showAlert({ title = "Heads up", message = "", glyph = "!", kind = "" } = {}) {
  return _showDialog({
    title, message, glyph,
    glyphKind: kind === "error" ? "danger" : kind === "success" ? "success" : "",
    cancelValue: undefined,
    buttons: [{ label: "OK", kind: "btn-primary", primary: true, value: undefined }],
  });
}

export function showConfirm({ title = "Are you sure?", message = "", confirmText = "Confirm", cancelText = "Cancel", danger = false, glyph } = {}) {
  return _showDialog({
    title, message,
    glyph: glyph || (danger ? "⚠" : "?"),
    glyphKind: danger ? "danger" : "",
    cancelValue: false,
    buttons: [
      { label: cancelText, kind: "btn-ghost", value: false },
      { label: confirmText, kind: danger ? "btn-danger" : "btn-primary", primary: true, value: true },
    ],
  });
}

export function showPrompt({ title = "Enter a value", message = "", placeholder = "", defaultValue = "", confirmText = "OK", cancelText = "Cancel", glyph = "✎" } = {}) {
  return _showDialog({
    title, message, glyph,
    cancelValue: null,
    fields: [{ placeholder, value: defaultValue }],
    buttons: [
      { label: cancelText, kind: "btn-ghost", value: null },
      { label: confirmText, kind: "btn-primary", primary: true, value: (inputs) => inputs[0].value },
    ],
  });
}

// ── Floating tooltip engine ────────────────────────────────────────────────
// One shared element follows the hovered/focused [data-tooltip] (and legacy
// .help-icon[data-tip]) target, positioned to stay on-screen.

let _tipEl = null;
function _tooltipEl() {
  if (!_tipEl) {
    _tipEl = document.createElement("div");
    _tipEl.id = "fu-tooltip";
    document.body.appendChild(_tipEl);
  }
  return _tipEl;
}

function _showTip(target) {
  const text = target.getAttribute("data-tooltip") || target.getAttribute("data-tip");
  if (!text) return;
  const tip = _tooltipEl();
  tip.textContent = text;
  tip.classList.remove("show");
  // measure
  tip.style.left = "0px";
  tip.style.top = "0px";
  const r = target.getBoundingClientRect();
  const tw = tip.offsetWidth;
  const th = tip.offsetHeight;
  const margin = 8;
  let left = r.left + r.width / 2 - tw / 2;
  left = Math.max(margin, Math.min(left, window.innerWidth - tw - margin));
  let top = r.top - th - 9;
  let placement = "top";
  if (top < margin) { top = r.bottom + 9; placement = "bottom"; }
  tip.setAttribute("data-placement", placement);
  const arrowX = r.left + r.width / 2 - left;
  tip.style.setProperty("--arrow-x", Math.max(10, Math.min(arrowX, tw - 10)) + "px");
  tip.style.left = Math.round(left) + "px";
  tip.style.top = Math.round(top) + "px";
  tip.classList.add("show");
}

function _hideTip() {
  if (_tipEl) _tipEl.classList.remove("show");
}

function initTooltips() {
  const sel = "[data-tooltip], .help-icon[data-tip]";
  document.addEventListener("mouseover", (e) => {
    const t = e.target.closest(sel);
    if (t) _showTip(t);
  });
  document.addEventListener("mouseout", (e) => {
    if (e.target.closest(sel)) _hideTip();
  });
  document.addEventListener("focusin", (e) => {
    const t = e.target.closest(sel);
    if (t) _showTip(t);
  });
  document.addEventListener("focusout", _hideTip);
  window.addEventListener("scroll", _hideTip, true);
}

// ── Scroll-reveal motion ───────────────────────────────────────────────────
// Elements marked [data-reveal] fade/rise in when they enter the viewport.
// Siblings cascade via a small stagger. Honors prefers-reduced-motion.

export function observeReveals(root = document) {
  const els = root.querySelectorAll("[data-reveal]:not(.in)");
  if (!els.length) return;
  if (window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
    els.forEach(el => el.classList.add("in"));
    return;
  }
  const io = new IntersectionObserver((entries, obs) => {
    const shown = [];
    for (const entry of entries) {
      if (entry.isIntersecting) { shown.push(entry.target); obs.unobserve(entry.target); }
    }
    shown.forEach((el, i) => {
      el.style.setProperty("--reveal-delay", Math.min(i, 8) * 55 + "ms");
      el.classList.add("in");
    });
  }, { threshold: 0.06, rootMargin: "0px 0px -5% 0px" });
  els.forEach(el => io.observe(el));

  // Safety net: nothing marked [data-reveal] may stay invisible. If an element
  // never trips the observer (off-screen content that's never scrolled to, a
  // display swap the observer missed), force it visible after a short grace.
  setTimeout(() => {
    els.forEach(el => { if (!el.classList.contains("in")) el.classList.add("in"); });
  }, 1400);
}

function initEnhancements() {
  initTooltips();
  observeReveals();
}

if (typeof document !== "undefined") {
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", initEnhancements);
  } else {
    initEnhancements();
  }
}

export function requireAuth() {
  if (!isLoggedIn()) {
    window.location.replace("/login");
    return false;
  }
  return true;
}

export function requireMaster() {
  const u = user.get();
  if (!u || u.role !== "master") {
    window.location.replace("/files");
    return false;
  }
  return true;
}

export async function logout() {
  await apiFetch("/auth/logout", { method: "POST" });
  csrf.clear();
  user.clear();
  window.location.replace("/login");
}

export function setupNav(active) {
  const u = user.get();
  const nameEl = document.getElementById("nav-user");
  if (nameEl && u) nameEl.textContent = u.username;

  const adminLink = document.getElementById("nav-admin");
  if (adminLink) {
    if (u && u.role === "master") adminLink.classList.remove("hidden");
    else adminLink.classList.add("hidden");
  }

  document.querySelectorAll(".nav-link[data-page]").forEach(el => {
    if (el.dataset.page === active) el.classList.add("active");
  });

  const logoutBtn = document.getElementById("nav-logout");
  if (logoutBtn) logoutBtn.addEventListener("click", logout);
}
