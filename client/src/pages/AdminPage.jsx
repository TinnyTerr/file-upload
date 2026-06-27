import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { apiFetch, isLoggedIn, formatBytes, formatDate, parseSize, parseDuration, user, logout } from '../lib/api.js';
import { showToast } from '../lib/toast.js';
import { showConfirm, showPrompt, showCopyModal } from '../lib/dialog.js';

// ── Helpers ───────────────────────────────────────────────────────────────
function pctOf(value, total) {
  return total > 0 ? Math.min(100, Math.max(0, (value / total) * 100)) : 0;
}

function typeColor(ct) {
  if (!ct) return null;
  if (ct.startsWith("image/")) return "#a78bfa";
  if (ct.startsWith("video/")) return "#60a5fa";
  if (ct.startsWith("audio/")) return "#34d399";
  if (ct === "application/pdf") return "#f87171";
  if (ct.startsWith("text/")) return "#fbbf24";
  if (/zip|tar|gzip|7z|rar/.test(ct)) return "#fb923c";
  return null;
}

function actionBadgeClass(action) {
  if (/(deleted|deactivat|revoked|broken|failed)/i.test(action)) return "badge badge-red";
  if (/(created|uploaded|added|login)/i.test(action))            return "badge badge-green";
  if (/(updated|edited|changed|reset)/i.test(action))            return "badge badge-orange";
  return "badge badge-gray";
}

function adminLinkUrl(slug, f) {
  const base = `${location.origin}/file/${slug}`;
  if (f?.encryption_mode === "server" && f?.access_key) return base + "?ek=" + encodeURIComponent(f.access_key);
  return base;
}

function adminDirUrl(d) {
  let url = d.url || `${location.origin}/d/${d.slug}`;
  if (d.encryption_mode === "server" && d.access_key) url += "?ek=" + encodeURIComponent(d.access_key);
  return url;
}

// ── Bar chart row ─────────────────────────────────────────────────────────
function BarRow({ label, value, total, tip, color, tone, bytes }) {
  const pct = pctOf(value, total || 1);
  const fillCls = tone === "capacity"
    ? `quota-bar-fill capacity${pct >= 90 ? " danger" : pct >= 70 ? " warn" : ""}`
    : "quota-bar-fill info";
  const displayVal = bytes ? `${formatBytes(value)} / ${formatBytes(total)}` : value.toLocaleString();
  return (
    <div data-tooltip={tip} style={{ marginBottom: "10px" }}>
      <div className="chart-row-head">
        <span className="chart-row-label">{label}</span>
        <span className="chart-row-value">
          {displayVal}
          {bytes && (
            <span style={{ fontFamily: "var(--font-mono)", fontSize: "11px", color: "var(--text-muted)", marginLeft: "6px" }}>
              {pct.toFixed(1)}%
            </span>
          )}
        </span>
      </div>
      <div className="quota-bar" style={{ height: "7px" }}>
        <div
          className={fillCls}
          style={{ width: pct.toFixed(1) + "%", ...(color ? { background: color } : {}) }}
        />
      </div>
    </div>
  );
}

// ── Status pills ──────────────────────────────────────────────────────────
const STATUS_COLORS = {
  active: "var(--success)",
  inactive: "var(--text-muted)",
  expired: "var(--danger)",
  used_up: "var(--warning)",
  archived: "var(--accent)",
  archiving: "var(--warning)",
  unarchiving: "var(--warning)",
  revoked: "var(--text-muted)",
  bound: "var(--accent)",
  unbound: "var(--text-dim)",
};

function StatusPills({ counts, labels }) {
  const entries = Object.entries(counts || {});
  if (!entries.length) return <div className="text-sm text-muted">No data yet.</div>;
  return (
    <div style={{ display: "flex", gap: "8px", flexWrap: "wrap" }}>
      {entries.map(([key, value]) => {
        const info = labels[key] || {};
        const color = info.color || STATUS_COLORS[key] || "var(--text-dim)";
        const num = Number(value || 0);
        return (
          <div key={key} className="status-pill" data-tooltip={info.tip}
               style={{ borderLeft: `2px solid ${color}`, background: "var(--surface-2)" }}>
            <strong style={{ color, textShadow: num > 0 && color !== "var(--text-muted)" ? `0 0 18px ${color}60` : undefined }}>
              {num.toLocaleString()}
            </strong>
            <span>{info.label || key.replaceAll("_", " ")}</span>
          </div>
        );
      })}
    </div>
  );
}

// ── Storage ring ──────────────────────────────────────────────────────────
function StorageRing({ used, total, tip }) {
  const fillRef = useRef(null);
  const glowRef = useRef(null);
  const mainRef = useRef(null);
  const radius = 51;
  const circumference = 2 * Math.PI * radius;
  const pct = pctOf(used, total);

  useEffect(() => {
    if (!fillRef.current) return;
    const arc = (circumference * pct / 100).toFixed(1);
    const da = `${arc} ${circumference.toFixed(1)}`;
    requestAnimationFrame(() => requestAnimationFrame(() => {
      if (fillRef.current) fillRef.current.setAttribute("stroke-dasharray", da);
      if (glowRef.current) glowRef.current.setAttribute("stroke-dasharray", da);
      const start = performance.now();
      const dur = 900;
      const tick = (now) => {
        const t = Math.min(1, (now - start) / dur);
        const eased = 1 - Math.pow(1 - t, 3);
        if (mainRef.current) mainRef.current.textContent = `${(pct * eased).toFixed(1)}%`;
        if (t < 1) requestAnimationFrame(tick);
        else if (mainRef.current) mainRef.current.textContent = `${pct.toFixed(1)}%`;
      };
      requestAnimationFrame(tick);
    }));
  }, [pct, circumference]);

  return (
    <div id="storage-ring" style={{ position: "relative", display: "inline-flex", alignItems: "center", justifyContent: "center" }} data-tooltip={tip}>
      <svg viewBox="0 0 128 128" width="128" height="128">
        <circle className="storage-ring-track" cx="64" cy="64" r="51" />
        <circle className="storage-ring-glow" cx="64" cy="64" r="51"
          strokeDasharray={`0 ${circumference.toFixed(1)}`} ref={glowRef} />
        <circle className="storage-ring-fill" cx="64" cy="64" r="51"
          strokeDasharray={`0 ${circumference.toFixed(1)}`} ref={fillRef} />
      </svg>
      <div className="storage-ring-label" style={{ position: "absolute", textAlign: "center" }}>
        <div className="storage-ring-main" ref={mainRef}>0%</div>
        <div className="storage-ring-sub">used</div>
      </div>
    </div>
  );
}

// ── Metric tile ───────────────────────────────────────────────────────────
function MetricTile({ label, value, sub, tip }) {
  const valRef = useRef(null);
  useEffect(() => {
    const raw = parseFloat(String(value).replace(/,/g, ""));
    if (isNaN(raw) || raw <= 0 || String(value) !== raw.toLocaleString()) return;
    if (!valRef.current) return;
    valRef.current.textContent = "0";
    const dur = Math.min(900, 300 + raw * 0.4);
    const start = performance.now();
    const tick = (now) => {
      const t = Math.min(1, (now - start) / dur);
      const eased = 1 - Math.pow(1 - t, 3);
      if (valRef.current) valRef.current.textContent = Math.round(raw * eased).toLocaleString();
      if (t < 1) requestAnimationFrame(tick);
      else if (valRef.current) valRef.current.textContent = value;
    };
    requestAnimationFrame(tick);
  }, [value]);
  return (
    <div className="metric-tile" data-tooltip={tip}>
      <div className="metric-tile-label">{label}</div>
      <div className="metric-tile-value" ref={valRef}>{value}</div>
      <div className="metric-tile-sub">{sub || ""}</div>
    </div>
  );
}

// ── Stat list card ────────────────────────────────────────────────────────
function StatListCard({ title, rows, tip }) {
  if (!rows || !rows.length) return (
    <div className="dashboard-card" data-tooltip={tip}>
      <div className="dashboard-card-title">{title}</div>
      <div className="text-sm text-muted">No data yet.</div>
    </div>
  );
  return (
    <div className="dashboard-card" data-tooltip={tip}>
      <div className="dashboard-card-title">{title}</div>
      <div className="chart-list">
        {rows.slice(0, 6).map((r, i) => (
          <div key={i} style={{ display: "flex", alignItems: "center", gap: "10px", padding: "7px 0", borderBottom: "1px solid var(--border)" }}>
            <div style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{r.label}</div>
            <div className="chart-row-value">{r.value}</div>
            {r.sub && <div className="text-xs text-muted">{r.sub}</div>}
          </div>
        ))}
      </div>
    </div>
  );
}

// ── Permission badge ──────────────────────────────────────────────────────
function PBadge({ label, on, tip }) {
  return (
    <span className={on ? "badge badge-green" : "badge badge-gray"} style={{ opacity: on ? 1 : 0.5 }} data-tooltip={tip}>
      {label}
    </span>
  );
}

// ── Permission modal ──────────────────────────────────────────────────────
function PermModal({ user: u, onClose, onSaved }) {
  const [p, setP] = useState(u.permissions || {});
  const [quotaStr, setQuotaStr] = useState(p.quota_bytes != null ? formatBytes(p.quota_bytes) : "");
  const [maxFileStr, setMaxFileStr] = useState(p.max_file_bytes != null ? formatBytes(p.max_file_bytes) : "");
  const [alert, setAlert] = useState(null);
  const [saving, setSaving] = useState(false);

  function toggle(key) { setP(prev => ({ ...prev, [key]: !prev[key] })); }

  const perms = [
    ["can_upload", "Can upload files", "upload"],
    ["can_upload_client_encrypted", "Can upload client-side (end-to-end) encrypted files", "e2e enc"],
    ["can_delete", "Can delete own files", "delete"],
    ["can_regenerate_links", "Can regenerate share links", "regen links"],
    ["can_delete_links", "Can permanently delete share links", "del links"],
    ["can_create_directories", "Can create folder shares", "folders"],
    ["can_manage_lifecycle", "Can set lifecycle/archiving options", "lifecycle"],
    ["can_use_api_keys", "Can use API keys", "api keys"],
    ["can_use_p2p", "Can use P2P transfers", "p2p"],
    ["can_view_admin", "Can view admin panel", "view admin"],
    ["can_manage_users", "Can manage users", "manage users"],
    ["can_manage_storage", "Can manage storage settings", "manage storage"],
    ["can_manage_api_keys", "Can manage API keys for all users", "manage api"],
  ];

  async function handleSave() {
    const quotaBytes = parseSize(quotaStr.trim());
    const maxFileBytes = parseSize(maxFileStr.trim());
    if (quotaStr.trim() && quotaBytes === null) { setAlert('Invalid quota — use "100 GB"'); return; }
    if (maxFileStr.trim() && maxFileBytes === null) { setAlert('Invalid max file size — use "10 GB"'); return; }
    const body = {};
    for (const [k] of perms) body[k] = !!p[k];
    if (quotaBytes != null) body.quota_bytes = quotaBytes;
    if (maxFileBytes != null) body.max_file_bytes = maxFileBytes;
    setSaving(true);
    const resp = await apiFetch(`/users/${u.id}/permissions`, { method: "POST", json: body });
    setSaving(false);
    if (!resp.ok) {
      const d = await resp.json().catch(() => ({}));
      setAlert(d.detail || "Update failed.");
      return;
    }
    showToast("Permissions updated.");
    onSaved();
    onClose();
  }

  return (
    <div className="modal-overlay" onMouseDown={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="modal" role="dialog" aria-modal="true" style={{ maxWidth: "580px" }}>
        <div className="modal-title">Permissions — {u.username}</div>
        {alert && <div className="alert alert-error">{alert}</div>}
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "6px", marginBottom: "14px" }}>
          {perms.map(([key, tip, label]) => (
            <label key={key} className="checkbox-label" data-tooltip={tip}>
              <input type="checkbox" checked={!!p[key]} onChange={() => toggle(key)} />
              {label}
            </label>
          ))}
        </div>
        <div className="form-row">
          <div className="form-group">
            <label>Storage quota</label>
            <input type="text" value={quotaStr} onChange={e => setQuotaStr(e.target.value)} placeholder='e.g. "10 GB"' />
          </div>
          <div className="form-group">
            <label>Max file size</label>
            <input type="text" value={maxFileStr} onChange={e => setMaxFileStr(e.target.value)} placeholder='e.g. "2 GB"' />
          </div>
        </div>
        <div className="modal-footer">
          <button className="btn btn-ghost" onClick={onClose}>Cancel</button>
          <button className="btn btn-primary" disabled={saving} onClick={handleSave}>
            {saving ? "Saving…" : "Save permissions"}
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Edit user modal ────────────────────────────────────────────────────────
function EditUserModal({ user: u, onClose, onSaved }) {
  const [username, setUsername] = useState(u.username);
  const [password, setPassword] = useState("");
  const [role, setRole] = useState(u.role);
  const [alert, setAlert] = useState(null);
  const [saving, setSaving] = useState(false);

  async function handleSave() {
    if (!username.trim()) { setAlert("Username is required."); return; }
    if (password && password.length < 12) { setAlert("Password must be at least 12 characters."); return; }
    const body = { username: username.trim(), role };
    if (password) body.password = password;
    setSaving(true);
    const resp = await apiFetch(`/users/${u.id}`, { method: "PATCH", json: body });
    setSaving(false);
    if (!resp.ok) {
      const d = await resp.json().catch(() => ({}));
      setAlert(d.detail || "Update failed.");
      return;
    }
    showToast("User updated.");
    onSaved();
    onClose();
  }

  return (
    <div className="modal-overlay" onMouseDown={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="modal" role="dialog" aria-modal="true">
        <div className="modal-title">Edit — {u.username}</div>
        {alert && <div className="alert alert-error">{alert}</div>}
        <div className="form-group"><label>Username</label><input type="text" value={username} onChange={e => setUsername(e.target.value)} autoFocus /></div>
        <div className="form-group"><label>New password <span className="text-muted">(leave blank to keep current)</span></label><input type="password" value={password} onChange={e => setPassword(e.target.value)} /></div>
        <div className="form-group"><label>Role</label>
          <select value={role} onChange={e => setRole(e.target.value)}>
            <option value="user">user</option>
            <option value="master">master</option>
          </select>
        </div>
        <div className="modal-footer">
          <button className="btn btn-ghost" onClick={onClose}>Cancel</button>
          <button className="btn btn-primary" disabled={saving} onClick={handleSave}>{saving ? "Saving…" : "Save"}</button>
        </div>
      </div>
    </div>
  );
}

// ── Create user modal ─────────────────────────────────────────────────────
function CreateUserModal({ onClose, onCreated }) {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [role, setRole] = useState("user");
  const [canUpload, setCanUpload] = useState(true);
  const [alert, setAlert] = useState(null);
  const [saving, setSaving] = useState(false);

  async function handleCreate() {
    if (!username.trim()) { setAlert("Username is required."); return; }
    if (password.length < 12) { setAlert("Password must be at least 12 characters."); return; }
    setSaving(true);
    const resp = await apiFetch("/users/", { method: "POST", json: { username: username.trim(), password, role, can_upload: canUpload } });
    setSaving(false);
    if (resp.status === 409) { setAlert("Username already taken."); return; }
    if (!resp.ok) { const d = await resp.json().catch(() => ({})); setAlert(d.detail || "Failed."); return; }
    showToast(`User "${username.trim()}" created.`);
    onCreated();
    onClose();
  }

  return (
    <div className="modal-overlay" onMouseDown={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="modal" role="dialog" aria-modal="true">
        <div className="modal-title">Create user</div>
        {alert && <div className="alert alert-error">{alert}</div>}
        <div className="form-group"><label>Username</label><input type="text" value={username} onChange={e => setUsername(e.target.value)} autoFocus /></div>
        <div className="form-group"><label>Password</label><input type="password" value={password} onChange={e => setPassword(e.target.value)} /></div>
        <div className="form-group"><label>Role</label>
          <select value={role} onChange={e => setRole(e.target.value)}>
            <option value="user">user</option>
            <option value="master">master</option>
          </select>
        </div>
        <label className="checkbox-label"><input type="checkbox" checked={canUpload} onChange={e => setCanUpload(e.target.checked)} /> Can upload</label>
        <div className="modal-footer">
          <button className="btn btn-ghost" onClick={onClose}>Cancel</button>
          <button className="btn btn-primary" disabled={saving} onClick={handleCreate}>{saving ? "Creating…" : "Create"}</button>
        </div>
      </div>
    </div>
  );
}

// ── Link edit modal ────────────────────────────────────────────────────────
function LinkEditModal({ link, onClose, onSaved }) {
  const [maxUses, setMaxUses] = useState(link.max_uses != null ? String(link.max_uses) : "");
  const [expires, setExpires] = useState("");
  const [active, setActive] = useState(!!link.active);
  const [alert, setAlert] = useState(null);
  const [saving, setSaving] = useState(false);

  async function handleSave() {
    const expiresInSec = expires.trim() ? parseDuration(expires.trim()) : null;
    if (expires.trim() && expiresInSec === null) { setAlert('Invalid duration — use "7d", "24h"'); return; }
    const body = { active };
    body.max_uses = maxUses !== "" ? parseInt(maxUses, 10) : null;
    if (expiresInSec) body.expires_in_seconds = expiresInSec;
    setSaving(true);
    const resp = await apiFetch(`/links/${link.id}`, { method: "PATCH", json: body });
    setSaving(false);
    if (!resp.ok) { const d = await resp.json().catch(() => ({})); setAlert(d.detail || "Update failed."); return; }
    showToast("Link updated.");
    onSaved();
    onClose();
  }

  return (
    <div className="modal-overlay" onMouseDown={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="modal" role="dialog" aria-modal="true">
        <div className="modal-title">Edit link</div>
        {alert && <div className="alert alert-error">{alert}</div>}
        <div className="form-group"><label>Max downloads (blank=unlimited)</label><input type="number" min="1" value={maxUses} onChange={e => setMaxUses(e.target.value)} autoFocus /></div>
        <div className="form-group"><label>Add more time (e.g. "7d")</label><input type="text" value={expires} onChange={e => setExpires(e.target.value)} /></div>
        <label className="checkbox-label"><input type="checkbox" checked={active} onChange={e => setActive(e.target.checked)} /> Active</label>
        <div className="modal-footer">
          <button className="btn btn-ghost" onClick={onClose}>Cancel</button>
          <button className="btn btn-primary" disabled={saving} onClick={handleSave}>{saving ? "Saving…" : "Save"}</button>
        </div>
      </div>
    </div>
  );
}

// ── Admin file link panel ─────────────────────────────────────────────────
function AdminLinkPanel({ f, onRefresh }) {
  const [editLink, setEditLink] = useState(null);
  const now = Date.now();

  async function mintLink() {
    const resp = await apiFetch(`/files/${f.id}/links`, { method: "POST", json: {} });
    if (!resp.ok) { showToast("Failed to create link.", "error"); return; }
    const data = await resp.json();
    const url = adminLinkUrl(data.slug, f);
    showToast(f.encryption_mode === "client" ? "Link created — append the #ek= key before sharing." : "Link created & copied.");
    navigator.clipboard.writeText(url).catch(() => {});
    onRefresh();
  }

  async function deleteLink(id) {
    const ok = await showConfirm({ title: "Delete link?", message: "Permanently removes the share link. The file remains stored.", confirmText: "Delete link", danger: true });
    if (!ok) return;
    const resp = await apiFetch(`/links/${id}`, { method: "DELETE" });
    if (resp.ok) { showToast("Link deleted."); onRefresh(); }
    else showToast("Delete failed.", "error");
  }

  return (
    <div className="file-expand-body file-links-panel open">
      <button className="btn btn-ghost btn-sm" style={{ margin: "8px 0 4px" }} onClick={mintLink}>+ New link</button>
      {!f.links.length && <div style={{ padding: "4px 0 6px", fontSize: "12px", color: "var(--text-muted)" }}>No links yet — create one above.</div>}
      {f.links.map(lk => {
        const expired = lk.expires_at && new Date(lk.expires_at).getTime() < now;
        const usedUp = lk.max_uses != null && lk.use_count >= lk.max_uses;
        const inactive = !lk.active || expired || usedUp;
        const url = adminLinkUrl(lk.slug, f);
        return (
          <div key={lk.id} className="file-link-row">
            <span className="file-link-dot" style={{ background: inactive ? "var(--text-muted)" : "var(--success)" }} />
            <span className="file-link-slug" title={url}>{url}</span>
            {f.encryption_mode === "client" && (
              <span className="badge badge-orange" title="Append #ek= key before sharing">needs #ek=</span>
            )}
            <span className="file-link-meta">{lk.max_uses != null ? `${lk.use_count}/${lk.max_uses} dl` : `${lk.use_count} dl`}</span>
            <span className="file-link-meta">{lk.expires_at ? new Date(lk.expires_at).toLocaleDateString() : "no expiry"}</span>
            {inactive && <span className="badge badge-gray">{!lk.active ? "inactive" : expired ? "expired" : "used up"}</span>}
            <button className="btn btn-ghost btn-sm" onClick={() => showCopyModal(url, f.original_filename, {
              key: f.encryption_mode === "server" && f.access_key ? f.access_key : "",
              keyLabel: f.encryption_mode === "server" ? "Access key (?ek=)" : "",
              hint: f.encryption_mode === "client" ? "🔒 End-to-end encrypted — append #ek= before sharing." : "",
            })}>Copy</button>
            <button className="btn btn-ghost btn-sm" onClick={() => window.open(url, "_blank", "noopener")}>Open</button>
            {!inactive && (
              <>
                <button className="btn btn-ghost btn-sm" onClick={() => setEditLink(lk)}>Edit</button>
                <button className="btn btn-ghost btn-sm" onClick={async () => {
                  const resp = await apiFetch(`/links/${lk.id}`, { method: "PATCH", json: { active: false } });
                  if (resp.ok) { showToast("Link deactivated."); onRefresh(); }
                  else showToast("Failed.", "error");
                }}>Deactivate</button>
              </>
            )}
            {inactive && !lk.active && !expired && !usedUp && (
              <button className="btn btn-ghost btn-sm" onClick={async () => {
                const resp = await apiFetch(`/links/${lk.id}`, { method: "PATCH", json: { active: true } });
                if (resp.ok) { showToast("Link reactivated."); onRefresh(); }
                else showToast("Failed.", "error");
              }}>Reactivate</button>
            )}
            <button className="btn btn-ghost btn-sm" style={{ color: "var(--danger)" }} onClick={() => deleteLink(lk.id)}>Delete</button>
          </div>
        );
      })}
      {editLink && (
        <LinkEditModal link={editLink} onClose={() => setEditLink(null)} onSaved={onRefresh} />
      )}
    </div>
  );
}

// ── Admin file row ─────────────────────────────────────────────────────────
function AdminFileRow({ f, selected, onToggle, onRefresh }) {
  const [expanded, setExpanded] = useState(false);

  async function deleteFile() {
    const ok = await showConfirm({ title: "Delete file?", message: `"${f.original_filename}" and all its links will be permanently removed.`, confirmText: "Delete", danger: true });
    if (!ok) return;
    const resp = await apiFetch(`/files/${f.id}`, { method: "DELETE" });
    if (resp.ok) { showToast("File deleted."); onRefresh(); }
    else { const d = await resp.json().catch(() => ({})); showToast(d.detail || "Delete failed.", "error"); }
  }

  async function toggleArchive() {
    const endpoint = f.archived ? "unarchive" : "archive";
    const resp = await apiFetch(`/admin/files/${f.id}/${endpoint}`, { method: "POST", json: {} });
    if (resp.ok) {
      const d = await resp.json();
      showToast(f.archived ? "File unarchived." : `File archived. Saved ${formatBytes(d.archive_saved_bytes || 0)}.`);
      onRefresh();
    } else {
      const d = await resp.json().catch(() => ({}));
      showToast(d.detail || "Archive action failed.", "error");
    }
  }

  const activeLinks = f.links.filter(l => l.active).length;

  return (
    <div>
      <div
        className="file-row"
        title="Click to expand links"
        onClick={e => { if (e.target.closest("button,a,input,label")) return; setExpanded(o => !o); }}
      >
        <label className="select-cell custom-check" onClick={e => e.stopPropagation()}>
          <input type="checkbox" aria-label={`Select ${f.original_filename}`} checked={selected} onChange={onToggle} />
          <span className="custom-check-box"><svg viewBox="0 0 10 8"><polyline points="1.5,4 4,6.5 8.5,1.5"/></svg></span>
        </label>
        <div className="file-row-name" title={f.original_filename}>{f.original_filename}</div>
        <div className="file-row-size">{formatBytes(f.size_bytes)}</div>
        <div className="file-meta" style={{ fontSize: "11px" }}>{formatDate(f.created_at)}</div>
        <div className="text-xs text-muted" style={{ maxWidth: "120px", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{f.content_type || ""}</div>
        {f.encryption_mode === "client" && <span className="badge badge-orange" title="End-to-end encrypted">🔒 e2e</span>}
        {f.encryption_mode === "server" && <span className="badge badge-orange" title="Server-encrypted">🔐 server</span>}
        {f.compressed && <span className="badge badge-gray" title="Stored compressed">zst</span>}
        <div className="text-xs text-muted" style={{ whiteSpace: "nowrap" }} title="Last downloaded">
          {f.last_downloaded_at ? `↓ ${formatDate(f.last_downloaded_at)}` : "never dl"}
        </div>
        <span className={activeLinks > 0 ? "badge badge-green" : "badge badge-gray"} title="Active/total links">
          {activeLinks}/{f.links.length} links
        </span>
        <button className="file-expand-btn" onClick={e => { e.stopPropagation(); setExpanded(o => !o); }}>
          {expanded ? "▼ Links" : "▶ Links"}
        </button>
        <button className="btn btn-ghost btn-sm" onClick={e => { e.stopPropagation(); toggleArchive(); }}>
          {f.archived ? "Unarchive" : "Archive"}
        </button>
        <button className="btn btn-danger btn-sm" onClick={e => { e.stopPropagation(); deleteFile(); }}>Delete</button>
      </div>
      {expanded && <AdminLinkPanel f={f} onRefresh={onRefresh} />}
    </div>
  );
}

// ── Disk stats header ─────────────────────────────────────────────────────
function DiskStats({ stats }) {
  if (!stats) return null;
  return (
    <div id="disk-stats" className="stat-bar" style={{ display: "flex", gap: "16px", flexWrap: "wrap", marginBottom: "16px", fontSize: "13px" }}>
      <span>📁 {Number(stats.total_files).toLocaleString()} files</span>
      <span>💾 {formatBytes(stats.total_bytes)}</span>
      <span>👤 {Number(stats.total_users).toLocaleString()} users</span>
      <span>🔗 {Number(stats.total_links).toLocaleString()} links</span>
    </div>
  );
}

// ── Bulk action bar ────────────────────────────────────────────────────────
function BulkBar({ selectedFiles, selectedDirs, selectedKeys, onClear, onRefresh }) {
  const total = selectedFiles.size + selectedDirs.size + selectedKeys.size;
  if (!total) return null;

  async function run(action) {
    let ids = [];
    if (action === "delete_files" || action === "archive_files" || action === "unarchive_files") ids = [...selectedFiles];
    else if (action === "delete_directories") ids = [...selectedDirs];
    else if (["revoke_api_keys", "reset_api_key_ips"].includes(action) && selectedKeys.size) ids = [...selectedKeys];

    const BULK_META = {
      archive_files: { title: "Archive selected files", noun: "file" },
      unarchive_files: { title: "Unarchive selected files", noun: "file" },
      delete_files: { title: "Delete selected files", noun: "file" },
      delete_directories: { title: "Delete selected folders", noun: "folder" },
      revoke_api_keys: { title: "Revoke API keys", noun: "API key" },
      reset_api_key_ips: { title: "Reset key IP bindings", noun: "API key" },
    };
    const meta = BULK_META[action] || { title: action, noun: "item" };

    const previewResp = await apiFetch("/admin/bulk/preview", { method: "POST", json: { action, ids } });
    if (!previewResp.ok) { const d = await previewResp.json().catch(() => ({})); showToast(d.detail || "Preview failed.", "error"); return; }
    const preview = await previewResp.json();
    if (!preview.affected_count) { showToast("No matching records for that bulk action."); return; }

    const phrase = preview.confirmation_phrase;
    const typed = await showPrompt({
      title: meta.title,
      message: `This will affect ${preview.affected_count} ${meta.noun}${preview.affected_count !== 1 ? "s" : ""}. Type "${phrase}" to run it.`,
      placeholder: phrase,
      confirmText: "Run action",
      glyph: "!",
    });
    if (typed === null) return;
    if (typed !== phrase) { showToast("Confirmation phrase did not match.", "error"); return; }

    const runResp = await apiFetch("/admin/bulk/run", { method: "POST", json: { action, ids, confirm: phrase } });
    if (!runResp.ok) { const d = await runResp.json().catch(() => ({})); showToast(d.detail || "Bulk action failed.", "error"); return; }
    const result = await runResp.json();
    showToast(`${meta.title}: processed ${result.processed_count}.`);
    onClear();
    onRefresh();
  }

  return (
    <div className="bulk-action-bar visible">
      <span className="bulk-bar-count">{total} selected</span>
      {selectedFiles.size > 0 && (
        <>
          <button className="btn-bulk btn-bulk-neutral" onClick={() => run("archive_files")}>Archive</button>
          <button className="btn-bulk btn-bulk-neutral" onClick={() => run("unarchive_files")}>Unarchive</button>
          <button className="btn-bulk btn-bulk-danger" onClick={() => run("delete_files")}>Delete files</button>
        </>
      )}
      {selectedDirs.size > 0 && (
        <button className="btn-bulk btn-bulk-danger" onClick={() => run("delete_directories")}>Delete folders</button>
      )}
      {selectedKeys.size > 0 && (
        <>
          <button className="btn-bulk btn-bulk-danger" onClick={() => run("revoke_api_keys")}>Revoke keys</button>
          <button className="btn-bulk btn-bulk-neutral" onClick={() => run("reset_api_key_ips")}>Reset IPs</button>
        </>
      )}
      <button className="btn-bulk btn-bulk-neutral" id="bulk-bar-clear" onClick={onClear}>Clear selection</button>
    </div>
  );
}

const BULK_ACTIONS = [
  { key: "delete_inactive_links", label: "Delete inactive links", desc: "Inactive, expired, and used-up links will be permanently removed. Files remain stored.", danger: true },
  { key: "run_cleanup_jobs", label: "Run cleanup jobs", desc: "Temp expiry, idle deletion, link expiry, and lifecycle reconciliation will run now.", danger: false },
  { key: "archive_files", label: "Archive selected files", desc: "Selected eligible files will be archived/compressed.", danger: false, needsFiles: true },
  { key: "unarchive_files", label: "Unarchive selected files", desc: "Selected archived files will be restored after quota and disk checks.", danger: false, needsFiles: true },
  { key: "delete_files", label: "Delete selected files", desc: "Selected files and their links will be permanently removed.", danger: true, needsFiles: true },
  { key: "delete_directories", label: "Delete selected folders", desc: "Selected folders and every file inside them will be permanently removed.", danger: true, needsDirs: true },
  { key: "revoke_api_keys", label: "Revoke API keys", desc: "Selected active keys are used when any are checked; otherwise all active keys are previewed.", danger: true },
  { key: "reset_api_key_ips", label: "Reset key IP bindings", desc: "Selected bound keys are used when checked; otherwise all bound keys are previewed.", danger: false },
];

export default function AdminPage() {
  const navigate = useNavigate();
  const [tab, setTab] = useState("details");

  // Global state
  const [diskStats, setDiskStats] = useState(null);
  const [selectedFiles, setSelectedFiles] = useState(new Set());
  const [selectedDirs, setSelectedDirs] = useState(new Set());
  const [selectedKeys, setSelectedKeys] = useState(new Set());

  // Modals
  const [editUserModal, setEditUserModal] = useState(null);
  const [createUserModal, setCreateUserModal] = useState(false);
  const [permModal, setPermModal] = useState(null);

  // Tab data
  const [detailsData, setDetailsData] = useState(null);
  const [storageCap, setStorageCap] = useState("");
  const [usersData, setUsersData] = useState(null);
  const [userFilter, setUserFilter] = useState("");
  const [filesData, setFilesData] = useState(null);
  const [fileFilter, setFileFilter] = useState("");
  const [keysData, setKeysData] = useState(null);
  const [keyFilter, setKeyFilter] = useState("");
  const [keyStatusFilter, setKeyStatusFilter] = useState("");
  const [auditEntries, setAuditEntries] = useState([]);
  const [auditTotal, setAuditTotal] = useState(0);
  const [auditFiltered, setAuditFiltered] = useState(0);
  const [auditOffset, setAuditOffset] = useState(0);
  const [auditFilter, setAuditFilter] = useState("");
  const [auditActionFilter, setAuditActionFilter] = useState("");
  const [auditActions, setAuditActions] = useState([]);
  const [auditIntegrity, setAuditIntegrity] = useState(null);
  const [backendLogs, setBackendLogs] = useState(null);
  const [backendFilter, setBackendFilter] = useState("");
  const [backendLevel, setBackendLevel] = useState("");
  const [backendAutoRefresh, setBackendAutoRefresh] = useState(false);
  const [lifecycleResult, setLifecycleResult] = useState(null);

  const backendTimerRef = useRef(null);
  const auditSearchTimer = useRef(null);

  useEffect(() => {
    if (!isLoggedIn()) { navigate("/login", { replace: true }); return; }
    document.title = "Admin — Oxymoron";
    loadDiskStats();
    loadDetails();
  }, [navigate]);

  useEffect(() => {
    if (tab === "users") loadUsers();
    else if (tab === "files") loadAdminFiles();
    else if (tab === "keys") loadKeys();
    else if (tab === "audit") loadAudit(0);
    else if (tab === "backend") loadBackendLogs();
    else if (tab === "details") loadDetails();
  }, [tab]);

  useEffect(() => {
    if (backendAutoRefresh && tab === "backend") {
      backendTimerRef.current = setInterval(loadBackendLogs, 3000);
    }
    return () => { if (backendTimerRef.current) clearInterval(backendTimerRef.current); };
  }, [backendAutoRefresh, tab]);

  async function loadDiskStats() {
    try {
      const resp = await apiFetch("/files/disk-stats");
      if (resp.ok) setDiskStats(await resp.json());
    } catch {}
  }

  async function loadDetails() {
    const resp = await apiFetch("/admin/storage");
    if (!resp.ok) { showToast("Failed to load storage details.", "error"); return; }
    const d = await resp.json();
    setDetailsData(d);
    setStorageCap(formatBytes(d.global_storage_quota_bytes));
  }

  async function saveStorageCap() {
    const cap = parseSize(storageCap.trim());
    if (cap === null) { showToast('Invalid cap — use "500 GB"', "error"); return; }
    const resp = await apiFetch("/admin/storage", { method: "PATCH", json: { global_storage_quota_bytes: cap } });
    if (resp.ok) { showToast("Storage cap updated."); loadDetails(); loadDiskStats(); }
    else { const d = await resp.json().catch(() => ({})); showToast(d.detail || "Failed to update cap.", "error"); }
  }

  async function runLifecycle(endpoint) {
    const resp = await apiFetch(endpoint, { method: "POST", json: {} });
    if (!resp.ok) { showToast("Lifecycle action failed.", "error"); return; }
    const d = await resp.json();
    const msg = `Last run processed ${d.processed ?? 0} item(s).`;
    setLifecycleResult(msg);
    showToast(msg);
    loadDetails();
    loadAdminFiles();
  }

  async function loadUsers() {
    const [usersResp, filesResp, dirsResp] = await Promise.all([
      apiFetch("/users/"), apiFetch("/admin/files"), apiFetch("/admin/directories"),
    ]);
    if (!usersResp.ok) { showToast("Failed to load users.", "error"); return; }
    const { users } = await usersResp.json();
    const byOwner = {};
    if (filesResp.ok) {
      const { files } = await filesResp.json();
      for (const f of files) { const o = (byOwner[f.owner_id] ||= { count: 0, bytes: 0 }); o.count++; o.bytes += f.stored_size_bytes ?? f.size_bytes ?? 0; }
    }
    if (dirsResp.ok) {
      const { directories } = await dirsResp.json();
      for (const d of directories) { const o = (byOwner[d.owner_id] ||= { count: 0, bytes: 0 }); o.count += d.file_count || 0; o.bytes += d.total_bytes || 0; }
    }
    setUsersData({ users, byOwner });
  }

  async function deleteUser(id, username) {
    const ok = await showConfirm({ title: "Delete user?", message: `"${username}" will be removed along with all their files, folders, API keys, and share links. This cannot be undone.`, confirmText: "Delete user", danger: true });
    if (!ok) return;
    const resp = await apiFetch(`/users/${id}`, { method: "DELETE" });
    if (resp.ok) { showToast("User deleted."); loadUsers(); loadDiskStats(); }
    else { const d = await resp.json().catch(() => ({})); showToast(d.detail || "Delete failed.", "error"); }
  }

  async function loadAdminFiles() {
    const [usersResp, filesResp, dirsResp] = await Promise.all([
      apiFetch("/users/"), apiFetch("/admin/files"), apiFetch("/admin/directories"),
    ]);
    if (!usersResp.ok || !filesResp.ok || !dirsResp.ok) { showToast("Failed to load files.", "error"); return; }
    const { users } = await usersResp.json();
    const { files } = await filesResp.json();
    const { directories } = await dirsResp.json();
    setFilesData({ users, files, directories });
  }

  async function loadKeys() {
    const resp = await apiFetch("/admin/keys");
    if (!resp.ok) { showToast("Failed to load API keys.", "error"); return; }
    const data = await resp.json();
    setKeysData(data.keys || []);
  }

  async function loadAudit(offset = auditOffset) {
    const params = new URLSearchParams({ limit: "50", offset: String(offset) });
    if (auditFilter.trim()) params.set("q", auditFilter.trim());
    if (auditActionFilter) params.set("action", auditActionFilter);
    const resp = await apiFetch(`/audit/?${params.toString()}`);
    if (!resp.ok) { showToast("Failed to load audit log.", "error"); return; }
    const { entries, chain_ok, actions, total_count, filtered_count } = await resp.json();
    setAuditEntries(entries);
    setAuditTotal(Number(total_count || 0));
    setAuditFiltered(Number(filtered_count || 0));
    setAuditOffset(offset);
    setAuditIntegrity({ ok: chain_ok });
    setAuditActions(actions || []);
  }

  async function loadBackendLogs() {
    const params = new URLSearchParams({ limit: "300" });
    if (backendFilter.trim()) params.set("q", backendFilter.trim());
    if (backendLevel) params.set("level", backendLevel);
    const resp = await apiFetch(`/admin/backend/logs?${params.toString()}`);
    if (!resp.ok) { showToast("Failed to load backend logs.", "error"); return; }
    setBackendLogs(await resp.json());
  }

  async function restartWorkers() {
    const ok = await showConfirm({
      title: "Restart backend workers?",
      message: "This restarts the background scheduler jobs for lifecycle scans, cleanup, link expiry, and stale upload cleanup.",
      confirmText: "Restart workers",
      danger: true,
    });
    if (!ok) return;
    const resp = await apiFetch("/admin/backend/restart-workers", { method: "POST", json: {} });
    if (!resp.ok) { const d = await resp.json().catch(() => ({})); showToast(d.detail || "Failed.", "error"); return; }
    const d = await resp.json();
    showToast(`Backend workers ${d.status}.`);
    loadBackendLogs();
  }

  async function revokeKey(id) {
    const ok = await showConfirm({ title: "Revoke API key?", message: "Any integration using this key will immediately stop working. This cannot be undone.", confirmText: "Revoke key", danger: true });
    if (!ok) return;
    const resp = await apiFetch(`/keys/${id}`, { method: "DELETE" });
    if (resp.ok) { showToast("Key revoked."); loadKeys(); }
    else { const d = await resp.json().catch(() => ({})); showToast(d.detail || "Failed.", "error"); }
  }

  async function resetKeyIP(id) {
    const pw = await showPrompt({ title: "Reset IP binding", message: "Enter your current password to confirm.", placeholder: "password", confirmText: "Reset IP" });
    if (!pw) return;
    const resp = await apiFetch(`/keys/${id}/reset-ip`, { method: "POST", json: { password: pw } });
    if (resp.ok) { showToast("IP binding cleared."); loadKeys(); }
    else { const d = await resp.json().catch(() => ({})); showToast(d.detail || "Failed.", "error"); }
  }

  async function runDangerAction(action) {
    const NOUN = {
      delete_inactive_links: { noun: "link", title: "Delete inactive links" },
      run_cleanup_jobs: { noun: "job", title: "Run cleanup jobs" },
      archive_files: { noun: "file", title: "Archive selected files" },
      unarchive_files: { noun: "file", title: "Unarchive selected files" },
      delete_files: { noun: "file", title: "Delete selected files" },
      delete_directories: { noun: "folder", title: "Delete selected folders" },
      revoke_api_keys: { noun: "API key", title: "Revoke API keys" },
      reset_api_key_ips: { noun: "API key", title: "Reset key IP bindings" },
    };
    const meta = NOUN[action] || { noun: "item", title: action };
    let ids = [];
    if (action === "delete_files" || action === "archive_files" || action === "unarchive_files") ids = [...selectedFiles];
    else if (action === "delete_directories") ids = [...selectedDirs];
    else if (["revoke_api_keys", "reset_api_key_ips"].includes(action)) ids = [...selectedKeys];

    const previewResp = await apiFetch("/admin/bulk/preview", { method: "POST", json: { action, ids } });
    if (!previewResp.ok) { const d = await previewResp.json().catch(() => ({})); showToast(d.detail || "Preview failed.", "error"); return; }
    const preview = await previewResp.json();
    if (!preview.affected_count) { showToast("No matching records for that action."); return; }
    const phrase = preview.confirmation_phrase;
    const typed = await showPrompt({
      title: meta.title,
      message: `This will affect ${preview.affected_count} ${meta.noun}${preview.affected_count !== 1 ? "s" : ""}. Type "${phrase}" to run it.`,
      placeholder: phrase,
      confirmText: "Run action",
      glyph: "!",
    });
    if (typed === null) return;
    if (typed !== phrase) { showToast("Confirmation phrase did not match.", "error"); return; }
    const runResp = await apiFetch("/admin/bulk/run", { method: "POST", json: { action, ids, confirm: phrase } });
    if (!runResp.ok) { const d = await runResp.json().catch(() => ({})); showToast(d.detail || "Bulk action failed.", "error"); return; }
    const result = await runResp.json();
    showToast(`${meta.title}: processed ${result.processed_count}.`);
    if (["delete_files", "archive_files", "unarchive_files"].includes(action)) setSelectedFiles(new Set());
    if (action === "delete_directories") setSelectedDirs(new Set());
    if (["revoke_api_keys", "reset_api_key_ips"].includes(action)) setSelectedKeys(new Set());
    loadDiskStats();
    loadDetails();
    loadAdminFiles();
    loadKeys();
  }

  // Filter helpers
  const filteredUsers = (usersData?.users || []).filter(u => {
    if (!userFilter.trim()) return true;
    return [u.username, u.role, String(u.id)].some(v => (v || "").toLowerCase().includes(userFilter.toLowerCase()));
  });

  const filteredFiles = (() => {
    if (!filesData) return { dirs: [], files: [], userMap: {} };
    const userMap = {};
    for (const u of filesData.users) userMap[u.id] = u;
    const n = fileFilter.trim().toLowerCase();
    if (!n) return { dirs: filesData.directories, files: filesData.files, userMap };
    return {
      dirs: filesData.directories.filter(d => [d.title, d.slug, userMap[d.owner_id]?.username || "", String(d.id)].some(v => (v || "").toLowerCase().includes(n))),
      files: filesData.files.filter(f => [f.original_filename, f.content_type, userMap[f.owner_id]?.username || "", String(f.id)].some(v => (v || "").toLowerCase().includes(n))),
      userMap,
    };
  })();

  const filteredKeys = (keysData || []).filter(k => {
    if (keyStatusFilter === "active" && !k.active) return false;
    if (keyStatusFilter === "inactive" && k.active) return false;
    if (keyStatusFilter === "bound" && !k.bound_ip) return false;
    if (keyStatusFilter === "unbound" && k.bound_ip) return false;
    if (!keyFilter.trim()) return true;
    return [k.owner_username, `uid:${k.owner_id}`, String(k.owner_id), String(k.user_key_number ?? k.id), k.bound_ip || ""].some(v => (v || "").toLowerCase().includes(keyFilter.toLowerCase()));
  });

  // Group files by owner for admin view
  const filesByOwner = {};
  for (const d of filteredFiles.dirs || []) {
    (filesByOwner[d.owner_id] ||= { dirs: [], files: [] }).dirs.push(d);
  }
  for (const f of filteredFiles.files || []) {
    (filesByOwner[f.owner_id] ||= { dirs: [], files: [] }).files.push(f);
  }

  const TABS = ["details", "users", "files", "keys", "audit", "danger", "backend"];
  const TAB_LABELS = { details: "Details", users: "Users", files: "Files", keys: "Keys", audit: "Audit", danger: "Danger Zone", backend: "Backend Logs" };

  return (
    <div className="page-wrap">
      <nav className="nav">
        <div className="nav-brand">Oxymoron</div>
        <div className="nav-links">
          <a className="nav-link" href="/files">Files</a>
          <a className="nav-link active" href="/admin">Admin</a>
        </div>
        <div className="nav-user-area">
          <span>{user.get()?.username}</span>
          <button className="btn btn-ghost btn-sm" onClick={logout}>Sign out</button>
        </div>
      </nav>

      <div className="container">
        <h1 className="page-title">Admin</h1>
        <DiskStats stats={diskStats} />

        {/* Tabs */}
        <div className="tabs">
          {TABS.map(t => (
            <button key={t} className={`tab${tab === t ? " active" : ""}`} onClick={() => setTab(t)}>
              {TAB_LABELS[t]}
            </button>
          ))}
        </div>

        <BulkBar
          selectedFiles={selectedFiles}
          selectedDirs={selectedDirs}
          selectedKeys={selectedKeys}
          onClear={() => { setSelectedFiles(new Set()); setSelectedDirs(new Set()); setSelectedKeys(new Set()); }}
          onRefresh={() => { loadDiskStats(); loadAdminFiles(); loadKeys(); }}
        />

        {/* Details tab */}
        {tab === "details" && (
          <div id="tab-details" className="tab-panel active">
            {detailsData && (
              <>
                <div style={{ display: "flex", gap: "24px", alignItems: "flex-start", flexWrap: "wrap", marginBottom: "24px" }}>
                  <StorageRing
                    used={detailsData.used_bytes}
                    total={detailsData.global_storage_quota_bytes}
                    tip={`${formatBytes(detailsData.used_bytes)} used of ${formatBytes(detailsData.global_storage_quota_bytes)} global storage cap.`}
                  />
                  <div style={{ flex: 1, minWidth: "200px" }}>
                    <div style={{ display: "flex", gap: "8px", alignItems: "center", marginBottom: "12px" }}>
                      <input type="text" value={storageCap} onChange={e => setStorageCap(e.target.value)} placeholder='e.g. "500 GB"' id="global-storage-cap" style={{ width: "180px" }} />
                      <button id="save-storage-cap" className="btn btn-ghost btn-sm" onClick={saveStorageCap}>Save cap</button>
                    </div>
                    <div id="storage-breakdown">
                      <BarRow label="Used storage" value={detailsData.used_bytes} total={detailsData.global_storage_quota_bytes} tip="Actual stored bytes counted against the global cap." tone="capacity" bytes />
                      <BarRow label="Allocated quotas" value={detailsData.allocated_quota_bytes} total={detailsData.global_storage_quota_bytes} tip="Sum of assigned user quotas compared with the global cap." tone="info" bytes />
                      <BarRow label="Free under cap" value={detailsData.storage_summary?.free_under_cap_bytes || 0} total={detailsData.global_storage_quota_bytes} tip="Remaining global cap after current stored bytes." tone="info" bytes />
                    </div>
                  </div>
                </div>

                <div id="details-kpis" className="metric-grid" style={{ display: "flex", gap: "12px", flexWrap: "wrap", marginBottom: "24px" }}>
                  <MetricTile label="Files" value={Number(detailsData.total_files || 0).toLocaleString()} sub="stored objects" tip="Total stored file records across every user." />
                  <MetricTile label="Links" value={`${Number(detailsData.active_links || 0).toLocaleString()} / ${Number(detailsData.total_links || 0).toLocaleString()}`} sub="active / total" tip="Usable links compared with every link record." />
                  <MetricTile label="API keys" value={Number(detailsData.total_api_keys || 0).toLocaleString()} sub="all users" tip="Total API key records, including revoked keys." />
                  <MetricTile label="Dedup savings" value={formatBytes(detailsData.dedup_saved_bytes || 0)} sub="saved by duplicate blobs" tip="Physical bytes avoided by storing duplicate content once." />
                  <MetricTile label="Archive savings" value={formatBytes(detailsData.archive_saved_bytes || 0)} sub="saved by archiving" tip="Bytes saved by archived/compressed files." />
                  <MetricTile label="Disk free" value={formatBytes(detailsData.disk?.free_bytes || 0)} sub="filesystem" tip="Free disk space on the storage volume." />
                  <MetricTile label="Users" value={Number((detailsData.users || []).length).toLocaleString()} sub="accounts" tip="Total users visible to admin." />
                </div>

                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "20px", marginBottom: "24px" }}>
                  <div id="user-usage-chart">
                    <div className="dashboard-card-title">Storage per user</div>
                    {(detailsData.users || []).map((u, i) => (
                      <BarRow key={u.id} label={u.username} value={u.used_bytes || 0} total={u.quota_bytes || Math.max(u.used_bytes || 0, 1)} tip={`${u.username}: ${formatBytes(u.used_bytes || 0)} used of ${u.quota_bytes ? formatBytes(u.quota_bytes) : "no quota"}`} tone="capacity" bytes />
                    ))}
                  </div>
                  <div>
                    <div className="dashboard-card-title">Lifecycle</div>
                    <StatusPills counts={detailsData.lifecycle_counts} labels={{
                      active:      { label: "active",      tip: "Files in normal downloadable state.", color: "var(--success)" },
                      archived:    { label: "archived",    tip: "Files compressed by lifecycle/archive controls.", color: "var(--accent)" },
                      archiving:   { label: "archiving",   tip: "Files currently being archived.", color: "var(--warning)" },
                      unarchiving: { label: "unarchiving", tip: "Files currently expanding back.", color: "var(--warning)" },
                    }} />
                    <div className="dashboard-card-title" style={{ marginTop: "16px" }}>Link status</div>
                    <StatusPills counts={detailsData.link_status_counts} labels={{
                      active:   { label: "active",   tip: "Usable links right now.",                  color: "var(--success)" },
                      inactive: { label: "inactive", tip: "Manually deactivated links.",              color: "var(--text-muted)" },
                      expired:  { label: "expired",  tip: "Links past their expiry timestamp.",       color: "var(--danger)" },
                      used_up:  { label: "used up",  tip: "Links that reached their download limit.", color: "var(--warning)" },
                    }} />
                    <div className="dashboard-card-title" style={{ marginTop: "16px" }}>API key status</div>
                    <StatusPills counts={detailsData.api_key_status_counts} labels={{
                      active:   { label: "active",   tip: "Keys that can authenticate API requests.",     color: "var(--success)" },
                      inactive: { label: "revoked",  tip: "Keys that were revoked.",                      color: "var(--text-muted)" },
                      bound:    { label: "IP bound", tip: "Keys pinned to a first-use IP address.",       color: "var(--accent)" },
                      unbound:  { label: "unbound",  tip: "Keys that will bind to their next client IP.", color: "var(--text-dim)" },
                    }} />
                  </div>
                </div>

                <div id="file-type-chart" className="dashboard-card" style={{ marginBottom: "20px" }}>
                  <div className="dashboard-card-title">File types by storage</div>
                  {(detailsData.content_type_counts || []).map((row, i) => (
                    <BarRow key={i} label={row.content_type} value={row.stored_bytes || 0} total={(detailsData.content_type_counts || []).reduce((s, r) => s + (r.stored_bytes || 0), 0) || 1} tip={`${row.count} file(s), ${formatBytes(row.stored_bytes || 0)} stored.`} color={typeColor(row.content_type)} bytes />
                  ))}
                </div>

                <div className="dashboard-card" style={{ marginBottom: "20px" }}>
                  <div className="dashboard-card-title">Lifecycle controls</div>
                  <div style={{ display: "flex", gap: "8px", flexWrap: "wrap", marginBottom: "8px" }}>
                    {[
                      ["/admin/lifecycle/archive-idle", "Archive idle files"],
                      ["/admin/lifecycle/unarchive-queued", "Unarchive queued"],
                      ["/admin/lifecycle/expire-temp", "Expire temp files"],
                      ["/admin/lifecycle/delete-idle", "Delete idle files"],
                    ].map(([ep, label]) => (
                      <button key={ep} className="btn btn-ghost btn-sm" data-lifecycle={ep} onClick={() => runLifecycle(ep)}>{label}</button>
                    ))}
                  </div>
                  {lifecycleResult && <div id="lifecycle-last-result" className="text-sm text-muted">{lifecycleResult}</div>}
                </div>

                {/* Fun stats */}
                {detailsData.fun_stats && (
                  <div id="fun-stats-grid" style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(300px, 1fr))", gap: "16px" }}>
                    <StatListCard title="Most downloaded" tip="Files ranked by total link use counts."
                      rows={(detailsData.fun_stats.top_downloaded_files || []).map(r => ({ label: r.filename, value: `${Number(r.downloads || 0).toLocaleString()} dl`, sub: `file ${r.id}` }))} />
                    <StatListCard title="Biggest files" tip="Largest logical file rows."
                      rows={(detailsData.fun_stats.biggest_files || []).map(r => ({ label: r.filename, value: formatBytes(r.size_bytes || 0), sub: `stored ${formatBytes(r.stored_size_bytes || 0)}` }))} />
                    <StatListCard title="Top storage users" tip="Users ranked by logical bytes charged to their quota."
                      rows={(detailsData.fun_stats.top_storage_users || []).map(r => ({ label: r.username, value: formatBytes(r.used_bytes || 0), sub: r.quota_bytes ? `of ${formatBytes(r.quota_bytes)}` : "" }))} />
                    <StatListCard title="Busy folders" tip="Folders with the most files."
                      rows={(detailsData.fun_stats.busiest_directories || []).map(r => ({ label: r.title, value: `${Number(r.file_count || 0).toLocaleString()} files`, sub: formatBytes(r.total_bytes || 0) }))} />
                  </div>
                )}
              </>
            )}
          </div>
        )}

        {/* Users tab */}
        {tab === "users" && (
          <div id="tab-users" className="tab-panel active">
            <div style={{ display: "flex", gap: "8px", marginBottom: "12px" }}>
              <input type="text" value={userFilter} onChange={e => { setUserFilter(e.target.value); if (tab === "users") loadUsers(); }} placeholder="Filter users…" id="user-filter" style={{ flex: 1 }} />
              <button id="create-user-btn" className="btn btn-primary" onClick={() => setCreateUserModal(true)}>+ Create user</button>
            </div>
            <div className="card" style={{ padding: 0, overflow: "hidden" }}>
              <table style={{ width: "100%", borderCollapse: "collapse" }}>
                <thead>
                  <tr style={{ borderBottom: "1px solid var(--border)", background: "var(--surface-2)" }}>
                    <th style={{ padding: "10px 14px", textAlign: "left", fontSize: "12px", color: "var(--text-muted)" }}>Username</th>
                    <th style={{ padding: "10px 14px", textAlign: "left", fontSize: "12px", color: "var(--text-muted)" }}>Role</th>
                    <th style={{ padding: "10px 14px", textAlign: "left", fontSize: "12px", color: "var(--text-muted)" }}>Permissions</th>
                    <th style={{ padding: "10px 14px", textAlign: "left", fontSize: "12px", color: "var(--text-muted)" }}>Files</th>
                    <th style={{ padding: "10px 14px", textAlign: "left", fontSize: "12px", color: "var(--text-muted)" }}>Storage</th>
                    <th style={{ padding: "10px 14px", textAlign: "left", fontSize: "12px", color: "var(--text-muted)" }}>Created</th>
                    <th style={{ padding: "10px 14px" }}></th>
                  </tr>
                </thead>
                <tbody id="users-tbody">
                  {!usersData && <tr><td colSpan={7} className="empty">Loading…</td></tr>}
                  {usersData && !filteredUsers.length && <tr><td colSpan={7} className="empty">No users match the filter.</td></tr>}
                  {filteredUsers.map(u => {
                    const p = u.permissions || {};
                    const stats = usersData?.byOwner?.[u.id] || { count: 0, bytes: 0 };
                    const quota = p.quota_bytes ?? 0;
                    const pct = quota > 0 ? Math.min(100, (stats.bytes / quota) * 100) : 0;
                    return (
                      <tr key={u.id} style={{ borderBottom: "1px solid var(--border)" }}>
                        <td style={{ padding: "10px 14px" }}>
                          <span style={{ fontWeight: 500 }}>{u.username}</span>
                          {u.must_change_credentials && <span className="badge badge-orange" style={{ marginLeft: "8px" }} title="Must change credentials">setup pending</span>}
                        </td>
                        <td style={{ padding: "10px 14px" }}>
                          <span className={u.role === "master" ? "badge badge-orange" : "badge badge-gray"} title={u.role === "master" ? "Master users bypass granular permissions." : "Regular user controlled by granular permissions."}>{u.role}</span>
                        </td>
                        <td style={{ padding: "10px 14px" }}>
                          <div style={{ display: "flex", gap: "4px", flexWrap: "wrap" }}>
                            <PBadge label="upload" on={!!p.can_upload} tip="Can upload files" />
                            <PBadge label="e2e" on={!!p.can_upload_client_encrypted} tip="Can upload client-side encrypted files" />
                            <PBadge label="delete" on={!!p.can_delete} tip="Can delete own files" />
                            <PBadge label="links" on={!!p.can_regenerate_links} tip="Can regenerate share links" />
                            <PBadge label="link-del" on={!!p.can_delete_links} tip="Can permanently delete share links" />
                            <PBadge label="folders" on={!!p.can_create_directories} tip="Can create folder shares" />
                            <PBadge label="life" on={!!p.can_manage_lifecycle} tip="Can set lifecycle/archiving options" />
                            <PBadge label="api" on={!!p.can_use_api_keys} tip="Can use API keys" />
                          </div>
                        </td>
                        <td className="td-mono text-xs" style={{ padding: "10px 14px" }}>{stats.count.toLocaleString()}</td>
                        <td style={{ padding: "10px 14px" }}>
                          <div className="text-xs text-muted" style={{ marginBottom: "3px" }}>{formatBytes(stats.bytes)} / {quota ? formatBytes(quota) : "∞"}</div>
                          <div className="quota-bar" style={{ maxWidth: "160px" }}>
                            <div className={`quota-bar-fill${pct >= 90 ? " danger" : pct >= 70 ? " warn" : ""}`} style={{ width: pct.toFixed(1) + "%" }} />
                          </div>
                        </td>
                        <td className="text-xs text-muted" style={{ padding: "10px 14px" }}>{formatDate(u.created_at)}</td>
                        <td style={{ padding: "10px 14px" }}>
                          <div className="td-actions">
                            <button className="btn btn-ghost btn-sm" onClick={() => setEditUserModal(u)}>Edit</button>
                            <button className="btn btn-ghost btn-sm" onClick={() => setPermModal(u)}>Permissions</button>
                            <button className="btn btn-danger btn-sm" onClick={() => deleteUser(u.id, u.username)}>Delete</button>
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {/* Files tab */}
        {tab === "files" && (
          <div id="tab-files" className="tab-panel active">
            <div style={{ display: "flex", gap: "8px", marginBottom: "12px" }}>
              <input type="text" id="admin-file-filter" value={fileFilter} onChange={e => setFileFilter(e.target.value)} placeholder="Filter by filename, owner, type…" style={{ flex: 1 }} />
              <button className="btn btn-ghost btn-sm" id="clear-file-selection" onClick={() => { setSelectedFiles(new Set()); setSelectedDirs(new Set()); }}>Clear selection</button>
            </div>
            <div id="files-by-user">
              {!filesData && <div className="empty">Loading…</div>}
              {filesData && !Object.keys(filesByOwner).length && (
                <div className="empty"><div className="empty-icon">📂</div>No files or folders yet.</div>
              )}
              {filesData && Object.entries(filesByOwner).map(([ownerId, { dirs, files }]) => {
                const owner = filteredFiles.userMap[ownerId];
                const totalBytes = files.reduce((s, f) => s + f.size_bytes, 0) + dirs.reduce((s, d) => s + (d.total_bytes || 0), 0);
                return (
                  <div key={ownerId} className="user-section">
                    <div className="user-section-header">
                      <span className="user-section-name">{owner ? owner.username : `User #${ownerId}`}</span>
                      <span className="badge badge-gray" title="Loose files owned by this user.">{files.length} file{files.length !== 1 ? "s" : ""}</span>
                      <span className="badge badge-green" title="Shareable folders owned by this user.">{dirs.length} folder{dirs.length !== 1 ? "s" : ""}</span>
                      <span className="text-xs text-muted">{formatBytes(totalBytes)}</span>
                    </div>
                    <div className="card" style={{ padding: 0 }}>
                      {dirs.map(d => (
                        <div key={d.id} className="file-row">
                          <label className="select-cell custom-check" onClick={e => e.stopPropagation()}>
                            <input type="checkbox" aria-label={`Select folder ${d.title}`} checked={selectedDirs.has(d.id)}
                              onChange={() => setSelectedDirs(prev => { const s = new Set(prev); s.has(d.id) ? s.delete(d.id) : s.add(d.id); return s; })} />
                            <span className="custom-check-box"><svg viewBox="0 0 10 8"><polyline points="1.5,4 4,6.5 8.5,1.5"/></svg></span>
                          </label>
                          <div className="file-row-name" title={d.title}>📁 {d.title}</div>
                          <div className="file-row-size">{formatBytes(d.total_bytes || 0)}</div>
                          <div className="file-meta" style={{ fontSize: "11px" }}>{formatDate(d.created_at)}</div>
                          <div className="text-xs text-muted">folder</div>
                          <span className="badge badge-gray">{d.file_count} file{d.file_count !== 1 ? "s" : ""}</span>
                          {d.encryption_mode === "client" && <span className="badge badge-orange">🔒 e2e</span>}
                          {d.encryption_mode === "server" && <span className="badge badge-orange">🔐 server</span>}
                          <button className="btn btn-ghost btn-sm" onClick={() => window.open(adminDirUrl(d), "_blank", "noopener")}>Open</button>
                          <button className="btn btn-ghost btn-sm" onClick={() => showCopyModal(adminDirUrl(d), d.title, {
                            hint: d.encryption_mode === "client" ? "🔒 End-to-end encrypted — the #ek= key is embedded in this URL."
                              : d.encryption_mode === "server" ? "🔐 Server-encrypted — the ?ek= access key is embedded in this URL." : "",
                          })}>Copy</button>
                          <button className="btn btn-danger btn-sm" onClick={async () => {
                            const ok = await showConfirm({ title: "Delete folder?", message: `"${d.title}" and all ${d.file_count} file${d.file_count !== 1 ? "s" : ""} inside will be permanently removed.`, confirmText: "Delete folder", danger: true });
                            if (!ok) return;
                            const resp = await apiFetch(`/directories/${d.id}`, { method: "DELETE" });
                            if (resp.ok) { showToast("Folder deleted."); loadAdminFiles(); loadDiskStats(); }
                            else { const dd = await resp.json().catch(() => ({})); showToast(dd.detail || "Delete failed.", "error"); }
                          }}>Delete all</button>
                        </div>
                      ))}
                      {files.map(f => (
                        <AdminFileRow
                          key={f.id}
                          f={f}
                          selected={selectedFiles.has(f.id)}
                          onToggle={() => setSelectedFiles(prev => { const s = new Set(prev); s.has(f.id) ? s.delete(f.id) : s.add(f.id); return s; })}
                          onRefresh={() => { loadAdminFiles(); loadDiskStats(); }}
                        />
                      ))}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {/* Keys tab */}
        {tab === "keys" && (
          <div id="tab-keys" className="tab-panel active">
            <div style={{ display: "flex", gap: "8px", marginBottom: "12px" }}>
              <input type="text" id="key-filter" value={keyFilter} onChange={e => { setKeyFilter(e.target.value); }} placeholder="Filter by username, IP…" style={{ flex: 1 }} />
              <select id="key-status-filter" value={keyStatusFilter} onChange={e => setKeyStatusFilter(e.target.value)}>
                <option value="">All statuses</option>
                <option value="active">Active</option>
                <option value="inactive">Inactive</option>
                <option value="bound">IP bound</option>
                <option value="unbound">Unbound</option>
              </select>
              <button id="create-key-btn" className="btn btn-ghost btn-sm" onClick={async () => {
                const resp = await apiFetch("/keys/", { method: "POST", json: {} });
                if (!resp.ok) { const d = await resp.json().catch(() => ({})); showToast(d.detail || "Failed to create key.", "error"); return; }
                const data = await resp.json();
                await showPrompt({ title: "New API key", message: `Copy this key now — it won't be shown again.\n\n${data.key}`, placeholder: "", confirmText: "Done" });
                loadKeys();
              }}>+ Create key</button>
            </div>
            <div id="keys-list">
              {!keysData && <div className="empty">Loading…</div>}
              {keysData && !keysData.length && <div className="empty"><div className="empty-icon">🔑</div>No API keys yet.</div>}
              {keysData && keysData.length > 0 && !filteredKeys.length && <div className="empty"><div className="empty-icon">⌕</div>No API keys match the filter.</div>}
              {filteredKeys.map(k => (
                <div key={k.id} className="card" style={{ marginBottom: "8px", padding: 0, overflow: "hidden" }}>
                  <div style={{ display: "flex", alignItems: "center", gap: "8px", padding: "10px 14px", borderBottom: "1px solid var(--border)" }}>
                    <label className="select-cell custom-check" onClick={e => e.stopPropagation()}>
                      <input type="checkbox" aria-label={`Select key #${k.user_key_number ?? k.id}`} checked={selectedKeys.has(k.id)}
                        onChange={() => setSelectedKeys(prev => { const s = new Set(prev); s.has(k.id) ? s.delete(k.id) : s.add(k.id); return s; })} />
                      <span className="custom-check-box"><svg viewBox="0 0 10 8"><polyline points="1.5,4 4,6.5 8.5,1.5"/></svg></span>
                    </label>
                    <span style={{ fontFamily: "var(--font-mono)", fontWeight: 500 }} title="Per-user API key number.">Key #{k.user_key_number ?? k.id}</span>
                    <span className="badge badge-gray" title="API key owner.">{k.owner_username || `uid:${k.owner_id}`}</span>
                    <span className="text-xs text-muted" title={k.bound_ip ? "This key is pinned to its first-use IP address." : "This key will bind to the next IP address that uses it."}>
                      {k.bound_ip ? `📍 ${k.bound_ip}` : "unbound"}
                    </span>
                    <span className={k.active ? "badge badge-green" : "badge badge-gray"} title={k.active ? "This key can authenticate API requests." : "This key is revoked."}>
                      {k.active ? "active" : "inactive"}
                    </span>
                    <div style={{ flex: 1 }} />
                    {k.active && (
                      <>
                        <button className="btn btn-ghost btn-sm" title="Clear this key's IP binding after password confirmation." onClick={() => resetKeyIP(k.id)}>Reset IP</button>
                        <button className="btn btn-ghost btn-sm" style={{ color: "var(--danger)" }} title="Revoke this key." onClick={() => revokeKey(k.id)}>Revoke</button>
                      </>
                    )}
                  </div>
                  <div style={{ padding: "8px 14px", fontSize: "12px", color: "var(--text-muted)" }}>
                    Created: {new Date(k.created_at).toLocaleString()}
                    {k.last_used_at && ` · Last used: ${new Date(k.last_used_at).toLocaleString()}`}
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Audit tab */}
        {tab === "audit" && (
          <div id="tab-audit" className="tab-panel active">
            <div style={{ display: "flex", gap: "8px", marginBottom: "12px", flexWrap: "wrap" }}>
              <input type="text" id="audit-filter" value={auditFilter} onChange={e => {
                setAuditFilter(e.target.value);
                clearTimeout(auditSearchTimer.current);
                auditSearchTimer.current = setTimeout(() => { setAuditOffset(0); loadAudit(0); }, 220);
              }} placeholder="Search actor, action, target, IP…" style={{ flex: 1 }} />
              <select id="audit-action-filter" value={auditActionFilter} onChange={e => { setAuditActionFilter(e.target.value); setAuditOffset(0); loadAudit(0); }}>
                <option value="">All actions</option>
                {auditActions.map(a => <option key={a} value={a}>{a}</option>)}
              </select>
              <button id="audit-clear" className="btn btn-ghost btn-sm" onClick={() => { setAuditFilter(""); setAuditActionFilter(""); setAuditOffset(0); loadAudit(0); }}>Clear</button>
              <button id="audit-refresh" className="btn btn-ghost btn-sm" onClick={() => loadAudit(auditOffset)}>Refresh</button>
            </div>
            {auditIntegrity && (
              <div id="audit-integrity" style={{ marginBottom: "10px", display: "flex", alignItems: "center", gap: "8px" }}>
                <span id="audit-integrity-badge" className={auditIntegrity.ok ? "badge badge-green" : "badge badge-red"}>{auditIntegrity.ok ? "verified" : "broken"}</span>
                <span id="audit-integrity-text" className="text-sm text-muted">
                  {auditIntegrity.ok ? "Audit log integrity is verified." : "Audit log integrity failed. Treat the log as potentially tampered until investigated."}
                </span>
              </div>
            )}
            <div className="card" style={{ padding: 0, overflow: "hidden" }}>
              <table style={{ width: "100%", borderCollapse: "collapse" }}>
                <thead>
                  <tr style={{ borderBottom: "1px solid var(--border)", background: "var(--surface-2)" }}>
                    {["#", "Actor", "Action", "Target", "IP", "Time"].map(h => (
                      <th key={h} style={{ padding: "8px 12px", textAlign: "left", fontSize: "12px", color: "var(--text-muted)" }}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody id="audit-tbody">
                  {!auditEntries.length && <tr><td colSpan={6} className="empty">No audit entries match the filters.</td></tr>}
                  {auditEntries.map(e => (
                    <tr key={e.id} style={{ borderBottom: "1px solid var(--border)" }}>
                      <td className="td-mono" style={{ padding: "8px 12px", fontSize: "12px" }}>{e.id}</td>
                      <td className="td-mono" style={{ padding: "8px 12px", fontSize: "12px" }}>{e.actor}</td>
                      <td style={{ padding: "8px 12px" }}><span className={actionBadgeClass(e.action)}>{e.action}</span></td>
                      <td className="text-xs text-muted" style={{ padding: "8px 12px" }}>{e.target || "–"}</td>
                      <td className="td-mono text-xs" style={{ padding: "8px 12px" }}>{e.ip || "–"}</td>
                      <td className="text-xs text-muted" style={{ padding: "8px 12px" }}>{formatDate(e.created_at)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: "10px", marginTop: "10px" }}>
              <button id="audit-prev" className="btn btn-ghost btn-sm" disabled={auditOffset === 0} onClick={() => { const off = Math.max(0, auditOffset - 50); setAuditOffset(off); loadAudit(off); }}>← Prev</button>
              <span id="audit-page" className="text-xs text-muted">
                {auditEntries.length ? `${auditOffset + 1}–${auditOffset + auditEntries.length} of ${(auditFiltered === auditTotal ? auditFiltered : `${auditFiltered} filtered (${auditTotal} total)`).toLocaleString()}` : "No audit entries"}
              </span>
              <button id="audit-next" className="btn btn-ghost btn-sm" disabled={auditOffset + auditEntries.length >= auditFiltered} onClick={() => { const off = auditOffset + 50; setAuditOffset(off); loadAudit(off); }}>Next →</button>
            </div>
          </div>
        )}

        {/* Danger Zone tab */}
        {tab === "danger" && (
          <div id="tab-danger" className="tab-panel active">
            <div className="alert alert-error" style={{ marginBottom: "16px" }}>
              ⚠ Actions on this page are irreversible. Most require typing a confirmation phrase.
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(300px, 1fr))", gap: "14px" }}>
              {BULK_ACTIONS.map(({ key, label, desc, danger, needsFiles, needsDirs }) => {
                const needsSel = needsFiles || needsDirs;
                const selCount = needsFiles ? selectedFiles.size : needsDirs ? selectedDirs.size : 0;
                const disabled = needsSel && selCount === 0;
                return (
                  <div key={key} className="action-card dashboard-card">
                    <div className="dashboard-card-title">{label}</div>
                    <div className="action-card-sub text-sm text-muted">{desc}</div>
                    {needsSel && (
                      <div className="text-xs text-muted" style={{ marginTop: "6px" }}>
                        {selCount > 0 ? `${selCount} ${needsFiles ? "file" : "folder"}${selCount !== 1 ? "s" : ""} selected.` : `No ${needsFiles ? "files" : "folders"} selected.`}
                      </div>
                    )}
                    <button
                      className={`btn ${danger ? "btn-danger" : "btn-ghost"} btn-sm`}
                      style={{ marginTop: "10px" }}
                      disabled={disabled}
                      data-bulk-action={key}
                      onClick={() => runDangerAction(key)}
                    >
                      {label}
                    </button>
                  </div>
                );
              })}
            </div>
            <div id="danger-result" style={{ display: "none" }} />
          </div>
        )}

        {/* Backend Logs tab */}
        {tab === "backend" && (
          <div id="tab-backend" className="tab-panel active">
            <div style={{ display: "flex", gap: "8px", marginBottom: "12px", flexWrap: "wrap" }}>
              <input type="text" id="backend-log-filter" value={backendFilter}
                onChange={e => {
                  setBackendFilter(e.target.value);
                  if (backendTimerRef.current) clearTimeout(backendTimerRef.current);
                  backendTimerRef.current = setTimeout(loadBackendLogs, 220);
                }}
                placeholder="Filter log messages…" style={{ flex: 1 }} />
              <select id="backend-log-level" value={backendLevel} onChange={e => { setBackendLevel(e.target.value); loadBackendLogs(); }}>
                <option value="">All levels</option>
                {["DEBUG", "INFO", "WARNING", "ERROR", "CRITICAL"].map(l => <option key={l} value={l}>{l}</option>)}
              </select>
              <label className="checkbox-label" style={{ whiteSpace: "nowrap" }}>
                <input id="backend-auto-refresh" type="checkbox" checked={backendAutoRefresh} onChange={e => setBackendAutoRefresh(e.target.checked)} />
                Auto-refresh
              </label>
              <button id="backend-refresh" className="btn btn-ghost btn-sm" onClick={loadBackendLogs}>Refresh</button>
              <button id="backend-restart-workers" className="btn btn-ghost btn-sm" style={{ color: "var(--danger)" }} onClick={restartWorkers}>Restart workers</button>
            </div>
            {backendLogs && (
              <div id="backend-log-status" className="text-xs text-muted" style={{ marginBottom: "8px" }}>
                {Number(backendLogs.filtered_count || 0).toLocaleString()} shown / {Number(backendLogs.total_count || 0).toLocaleString()} captured
              </div>
            )}
            <div id="backend-log-list">
              {!backendLogs && <div className="empty">Loading…</div>}
              {backendLogs && !(backendLogs.entries || []).length && <div className="empty">No backend logs match the filters.</div>}
              {(backendLogs?.entries || []).map((entry, i) => (
                <div key={i} className="backend-log-row"
                  data-tooltip={`${entry.module || entry.logger}:${entry.line || "?"} ${entry.function || ""}`.trim()}>
                  <div className="backend-log-time">{formatDate(entry.created_at)}</div>
                  <div className={`backend-level ${(entry.level || "").toLowerCase()}`}>{entry.level || "INFO"}</div>
                  <div className="backend-log-name">{entry.logger || "app"}</div>
                  <div className="backend-log-message">{entry.message || ""}</div>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>

      {/* Modals */}
      {createUserModal && (
        <CreateUserModal onClose={() => setCreateUserModal(false)} onCreated={() => { loadUsers(); loadDiskStats(); }} />
      )}
      {editUserModal && (
        <EditUserModal user={editUserModal} onClose={() => setEditUserModal(null)} onSaved={loadUsers} />
      )}
      {permModal && (
        <PermModal user={permModal} onClose={() => setPermModal(null)} onSaved={loadUsers} />
      )}
    </div>
  );
}
