import { apiFetch, requireAuth, requireMaster, setupNav, formatBytes, formatDate, parseSize, parseDuration, showToast, showConfirm, showPrompt, showCopyModal } from "./api.js";

if (!requireAuth()) throw new Error("not authenticated");
if (!requireMaster()) throw new Error("not master");
setupNav("admin");

// ── Disk stats ────────────────────────────────────────────────────────────
async function loadDiskStats() {
  let resp;
  try { resp = await apiFetch("/files/disk-stats"); } catch { return; }
  if (!resp.ok) return;
  const d = await resp.json();
  document.getElementById("stat-files").textContent   = d.total_files.toLocaleString();
  document.getElementById("stat-storage").textContent = formatBytes(d.total_bytes);
  document.getElementById("stat-users").textContent   = d.total_users.toLocaleString();
  document.getElementById("stat-links").textContent   = d.total_links.toLocaleString();
  document.getElementById("disk-stats").style.display = "";
}

// ── Tabs ──────────────────────────────────────────────────────────────────
document.querySelectorAll(".tab").forEach(tab => {
  tab.addEventListener("click", () => {
    document.querySelectorAll(".tab, .tab-panel").forEach(el => el.classList.remove("active"));
    tab.classList.add("active");
    document.getElementById(`tab-${tab.dataset.tab}`).classList.add("active");
    if (tab.dataset.tab === "audit") loadAudit();
    if (tab.dataset.tab === "details") loadDetails();
    if (tab.dataset.tab === "files") loadAdminFiles();
    if (tab.dataset.tab === "keys") loadKeys();
    if (tab.dataset.tab === "users") loadUsers();
    if (tab.dataset.tab === "danger") loadDangerZone();
    if (tab.dataset.tab === "backend") loadBackendLogs();
    syncBackendAutoRefresh();
  });
});

// ── Details / storage ─────────────────────────────────────────────────────
function setTooltip(el, text) {
  if (text) el.setAttribute("data-tooltip", text);
  return el;
}

function pctOf(value, total) {
  return total > 0 ? Math.min(100, Math.max(0, (value / total) * 100)) : 0;
}

function bar(label, used, total, tip, tone = "info") {
  const wrap = document.createElement("div");
  setTooltip(wrap, tip);
  const pct = pctOf(used, total);
  const lbl = document.createElement("div");
  lbl.className = "chart-row-head";
  const name = document.createElement("span");
  name.className = "chart-row-label";
  name.textContent = label;
  const val = document.createElement("span");
  val.className = "chart-row-value";
  val.textContent = `${formatBytes(used)} / ${formatBytes(total)}`;
  const pctSpan = document.createElement("span");
  pctSpan.style.cssText = "font-family:var(--font-mono);font-size:11px;color:var(--text-muted);margin-left:6px;";
  pctSpan.textContent = `${pct.toFixed(1)}%`;
  val.appendChild(pctSpan);
  lbl.append(name, val);
  const q = document.createElement("div");
  q.className = "quota-bar";
  q.style.height = "7px";
  const f = document.createElement("div");
  let cls = "quota-bar-fill info";
  if (tone === "capacity") cls = "quota-bar-fill capacity" + (pct >= 90 ? " danger" : pct >= 70 ? " warn" : "");
  f.className = cls;
  f.style.width = pct.toFixed(1) + "%";
  q.appendChild(f);
  wrap.append(lbl, q);
  return wrap;
}

function renderStorageRing(d) {
  const el = document.getElementById("storage-ring");
  el.textContent = "";
  const pct = pctOf(d.used_bytes, d.global_storage_quota_bytes);
  const radius = 51;
  const circumference = 2 * Math.PI * radius;
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 128 128");
  const cx = "64", cy = "64", r = String(radius);
  for (const cls of ["storage-ring-track", "storage-ring-glow", "storage-ring-fill"]) {
    const c = document.createElementNS("http://www.w3.org/2000/svg", "circle");
    c.setAttribute("class", cls);
    c.setAttribute("cx", cx); c.setAttribute("cy", cy); c.setAttribute("r", r);
    if (cls === "storage-ring-fill" || cls === "storage-ring-glow") {
      c.setAttribute("stroke-dasharray", `0 ${circumference.toFixed(1)}`);
    }
    svg.appendChild(c);
  }
  const label = document.createElement("div");
  label.className = "storage-ring-label";
  const main = document.createElement("div");
  main.className = "storage-ring-main";
  main.textContent = "0%";
  const sub = document.createElement("div");
  sub.className = "storage-ring-sub";
  sub.textContent = "used";
  label.append(main, sub);
  el.append(svg, label);
  setTooltip(el, `${formatBytes(d.used_bytes)} used of ${formatBytes(d.global_storage_quota_bytes)} global storage cap.`);
  // Animate the ring fill and number after paint
  requestAnimationFrame(() => requestAnimationFrame(() => {
    const fill = svg.querySelector(".storage-ring-fill");
    const glow = svg.querySelector(".storage-ring-glow");
    const arc = (circumference * pct / 100).toFixed(1);
    const da = `${arc} ${circumference.toFixed(1)}`;
    fill.setAttribute("stroke-dasharray", da);
    if (glow) glow.setAttribute("stroke-dasharray", da);
    const start = performance.now();
    const dur = 900;
    const tick = (now) => {
      const t = Math.min(1, (now - start) / dur);
      const eased = 1 - Math.pow(1 - t, 3);
      main.textContent = `${(pct * eased).toFixed(1)}%`;
      if (t < 1) requestAnimationFrame(tick);
      else main.textContent = `${pct.toFixed(1)}%`;
    };
    requestAnimationFrame(tick);
  }));
}

function metricTile(label, value, sub, tip) {
  const card = document.createElement("div");
  card.className = "metric-tile";
  setTooltip(card, tip);
  const l = document.createElement("div");
  l.className = "metric-tile-label";
  l.textContent = label;
  const v = document.createElement("div");
  v.className = "metric-tile-value";
  v.textContent = value;
  const s = document.createElement("div");
  s.className = "metric-tile-sub";
  s.textContent = sub || "";
  card.append(l, v, s);
  // Count-up for pure numbers
  const raw = parseFloat(String(value).replace(/,/g, ""));
  if (!isNaN(raw) && raw > 0 && String(value) === raw.toLocaleString()) {
    v.textContent = "0";
    const dur = Math.min(900, 300 + raw * 0.4);
    const start = performance.now();
    const tick = (now) => {
      const t = Math.min(1, (now - start) / dur);
      const eased = 1 - Math.pow(1 - t, 3);
      v.textContent = Math.round(raw * eased).toLocaleString();
      if (t < 1) requestAnimationFrame(tick);
      else v.textContent = value;
    };
    requestAnimationFrame(tick);
  }
  return card;
}

function renderMetricGrid(d) {
  const grid = document.getElementById("details-kpis");
  grid.textContent = "";
  grid.append(
    metricTile("Files", Number(d.total_files || 0).toLocaleString(), "stored objects", "Total stored file records across every user."),
    metricTile("Links", `${Number(d.active_links || 0).toLocaleString()} / ${Number(d.total_links || 0).toLocaleString()}`, "active / total", "Usable links compared with every link record."),
    metricTile("API keys", Number(d.total_api_keys || 0).toLocaleString(), "all users", "Total API key records, including revoked keys."),
    metricTile("Dedup savings", formatBytes(d.dedup_saved_bytes || 0), "saved by duplicate blobs", "Physical bytes avoided by storing duplicate content once."),
    metricTile("Archive savings", formatBytes(d.archive_saved_bytes || 0), "saved by archiving", "Bytes saved by archived/compressed files."),
    metricTile("Disk free", formatBytes(d.disk?.free_bytes || 0), "filesystem", "Free disk space on the storage volume."),
    metricTile("Users", Number((d.users || []).length).toLocaleString(), "accounts", "Total users visible to admin.")
  );
}

function statListCard(title, rows, render, tip) {
  const card = document.createElement("div");
  card.className = "dashboard-card";
  setTooltip(card, tip);
  const head = document.createElement("div");
  head.className = "dashboard-card-title";
  head.textContent = title;
  const body = document.createElement("div");
  body.className = "chart-list";
  if (!rows.length) {
    const empty = document.createElement("div");
    empty.className = "text-sm text-muted";
    empty.textContent = "No data yet.";
    body.appendChild(empty);
  } else {
    rows.slice(0, 6).forEach(row => body.appendChild(render(row)));
  }
  card.append(head, body);
  return card;
}

function statRow(label, value, sub = "") {
  const wrap = document.createElement("div");
  wrap.style.cssText = "display:flex;align-items:center;gap:10px;padding:7px 0;border-bottom:1px solid var(--border)";
  const name = document.createElement("div");
  name.style.cssText = "flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap";
  name.textContent = label;
  const val = document.createElement("div");
  val.className = "chart-row-value";
  val.textContent = value;
  wrap.append(name, val);
  if (sub) {
    const s = document.createElement("div");
    s.className = "text-xs text-muted";
    s.textContent = sub;
    wrap.appendChild(s);
  }
  return wrap;
}

function renderFunStats(d) {
  const grid = document.getElementById("fun-stats-grid");
  if (!grid) return;
  grid.textContent = "";
  const stats = d.fun_stats || {};
  const sourceRows = Object.entries(stats.source_type_counts || {}).map(([source, count]) => ({ source, count }));
  const typeRows = Object.entries(stats.file_type_counts || {}).map(([type, row]) => ({ type, ...row }));
  const remoteRows = Object.entries(stats.remote_upload_counts || {}).map(([status, count]) => ({ status, count }));
  grid.append(
    statListCard("Most downloaded", stats.top_downloaded_files || [], row =>
      statRow(row.filename, `${Number(row.downloads || 0).toLocaleString()} dl`, `file ${row.id}`),
      "Files ranked by total link use counts."
    ),
    statListCard("Biggest files", stats.biggest_files || [], row =>
      statRow(row.filename, formatBytes(row.size_bytes || 0), `stored ${formatBytes(row.stored_size_bytes || 0)}`),
      "Largest logical file rows."
    ),
    statListCard("Top storage users", stats.top_storage_users || [], row =>
      statRow(row.username, formatBytes(row.used_bytes || 0), row.quota_bytes ? `of ${formatBytes(row.quota_bytes)}` : ""),
      "Users ranked by logical bytes charged to their quota."
    ),
    statListCard("Upload sources", sourceRows, row =>
      statRow(row.source, Number(row.count || 0).toLocaleString()),
      "How files entered the system: local upload, remote URL, dropbox, or saved reference."
    ),
    statListCard("Top file types", typeRows.sort((a, b) => (b.bytes || 0) - (a.bytes || 0)), row =>
      statRow(row.type, formatBytes(row.bytes || 0), `${Number(row.count || 0).toLocaleString()} files`),
      "Logical bytes grouped by MIME type."
    ),
    statListCard("Busy folders", stats.busiest_directories || [], row =>
      statRow(row.title, `${Number(row.file_count || 0).toLocaleString()} files`, formatBytes(row.total_bytes || 0)),
      "Folders with the most logical bytes."
    ),
    statListCard("Remote jobs", remoteRows, row =>
      statRow(row.status, Number(row.count || 0).toLocaleString()),
      "Remote upload job status counts."
    )
  );
}

function renderBarList(id, rows, { bytes = false } = {}) {
  const el = document.getElementById(id);
  el.textContent = "";
  const filtered = rows.filter(r => (r.value || 0) > 0 || r.keepZero);
  if (!filtered.length) {
    const empty = document.createElement("div");
    empty.className = "text-sm text-muted";
    empty.textContent = "No data yet.";
    el.appendChild(empty);
    return;
  }
  const items = filtered.slice(0, 8);
  items.forEach((row, i) => {
    let wrap;
    if (bytes) {
      wrap = bar(row.label, row.value || 0, row.total || 0, row.tip, row.tone || "info");
    } else {
      const total = row.total || 1;
      wrap = document.createElement("div");
      setTooltip(wrap, row.tip);
      const head = document.createElement("div");
      head.className = "chart-row-head";
      const label = document.createElement("span");
      label.className = "chart-row-label";
      label.textContent = row.label;
      const val = document.createElement("span");
      val.className = "chart-row-value";
      val.textContent = Number(row.value || 0).toLocaleString();
      head.append(label, val);
      const q = document.createElement("div");
      q.className = "quota-bar";
      const f = document.createElement("div");
      f.className = row.color ? "quota-bar-fill" : "quota-bar-fill info";
      if (row.color) f.style.background = row.color;
      f.style.width = pctOf(row.value || 0, total).toFixed(1) + "%";
      f.style.animationDelay = `${i * 60}ms`;
      q.appendChild(f);
      wrap.append(head, q);
    }
    wrap.style.animationDelay = `${i * 40}ms`;
    el.appendChild(wrap);
  });
  // Stagger animate bar fills: set to 0, then allow CSS transition to target width
  requestAnimationFrame(() => {
    el.querySelectorAll(".quota-bar-fill").forEach((f, i) => {
      const target = f.style.width;
      f.style.transition = "none";
      f.style.width = "0";
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          f.style.transition = `width ${0.6 + i * 0.04}s cubic-bezier(0.16,1,0.3,1) ${i * 55}ms`;
          f.style.width = target;
        });
      });
    });
  });
}

function renderStatusPills(id, counts, labels = {}) {
  const el = document.getElementById(id);
  el.textContent = "";
  const entries = Object.entries(counts || {});
  if (!entries.length) {
    const empty = document.createElement("div");
    empty.className = "text-sm text-muted";
    empty.textContent = "No data yet.";
    el.appendChild(empty);
    return;
  }
  for (const [key, value] of entries) {
    const info = labels[key] || {};
    const pill = document.createElement("div");
    pill.className = "status-pill";
    setTooltip(pill, info.tip);
    const color = info.color || "var(--text-dim)";
    pill.style.cssText = `border-left: 2px solid ${color}; background: var(--surface-2);`;
    const strong = document.createElement("strong");
    const num = Number(value || 0);
    strong.textContent = num.toLocaleString();
    strong.style.color = color;
    if (num > 0 && color !== "var(--text-muted)" && color !== "var(--text-dim)") {
      strong.style.textShadow = `0 0 18px ${color}60`;
    }
    const span = document.createElement("span");
    span.textContent = info.label || key.replaceAll("_", " ");
    pill.append(strong, span);
    el.appendChild(pill);
  }
}

async function loadDetails() {
  const resp = await apiFetch("/admin/storage");
  if (!resp.ok) { showToast("Failed to load storage details.", "error"); return; }
  const d = await resp.json();
  document.getElementById("global-storage-cap").value = formatBytes(d.global_storage_quota_bytes);

  renderStorageRing(d);
  renderBarList("storage-breakdown", [
    { label: "Used storage", value: d.used_bytes, total: d.global_storage_quota_bytes, tip: "Actual stored bytes counted against the global cap.", keepZero: true, tone: "capacity" },
    { label: "Allocated quotas", value: d.allocated_quota_bytes, total: d.global_storage_quota_bytes, tip: "Sum of assigned user quotas compared with the global cap.", keepZero: true, tone: "info" },
    { label: "Free under cap", value: d.storage_summary?.free_under_cap_bytes || 0, total: d.global_storage_quota_bytes, tip: "Remaining global cap after current stored bytes.", keepZero: true, tone: "info" },
  ], { bytes: true });
  renderMetricGrid(d);

  renderBarList("user-usage-chart", (d.users || []).map(u => ({
    label: u.username,
    value: u.used_bytes || 0,
    total: u.quota_bytes || Math.max(u.used_bytes || 0, 1),
    tip: `${u.username}: ${formatBytes(u.used_bytes || 0)} used of ${u.quota_bytes ? formatBytes(u.quota_bytes) : "no quota"}`,
    tone: "capacity",
  })), { bytes: true });

  const typeTotal = (d.content_type_counts || []).reduce((sum, row) => sum + (row.stored_bytes || 0), 0);
  renderBarList("file-type-chart", (d.content_type_counts || []).map(row => ({
    label: row.content_type,
    value: row.stored_bytes || 0,
    total: typeTotal || 1,
    tip: `${row.count} file(s), ${formatBytes(row.stored_bytes || 0)} stored.`,
    color: typeColor(row.content_type),
  })), { bytes: true });

  renderStatusPills("lifecycle-chart", d.lifecycle_counts, {
    active:      { label: "active",      tip: "Files in normal downloadable state.",                            color: "var(--success)" },
    archived:    { label: "archived",    tip: "Files compressed by lifecycle/archive controls.",                color: "var(--accent)" },
    archiving:   { label: "archiving",   tip: "Files currently being archived or left stale by interruption.", color: "var(--warning)" },
    unarchiving: { label: "unarchiving", tip: "Files currently expanding back to normal storage.",             color: "var(--warning)" },
  });
  renderStatusPills("link-status-chart", d.link_status_counts, {
    active:   { label: "active",   tip: "Usable links right now.",                  color: "var(--success)" },
    inactive: { label: "inactive", tip: "Manually deactivated links.",              color: "var(--text-muted)" },
    expired:  { label: "expired",  tip: "Links past their expiry timestamp.",       color: "var(--danger)" },
    used_up:  { label: "used up",  tip: "Links that reached their download limit.", color: "var(--warning)" },
  });
  renderStatusPills("api-key-chart", d.api_key_status_counts, {
    active:   { label: "active",   tip: "Keys that can authenticate API requests.",     color: "var(--success)" },
    inactive: { label: "revoked",  tip: "Keys that were revoked and no longer work.",   color: "var(--text-muted)" },
    bound:    { label: "IP bound", tip: "Keys pinned to a first-use IP address.",       color: "var(--accent)" },
    unbound:  { label: "unbound",  tip: "Keys that will bind to their next client IP.", color: "var(--text-dim)" },
  });
  const auditTotal = (d.recent_audit_counts || []).reduce((sum, row) => sum + (row.count || 0), 0);
  renderBarList("audit-activity-chart", (d.recent_audit_counts || []).map(row => ({
    label: row.action,
    value: row.count || 0,
    total: auditTotal || 1,
    tip: `${row.count} audit entr${row.count === 1 ? "y" : "ies"} for ${row.action}.`
  })));
  renderFunStats(d);
}

document.getElementById("save-storage-cap").addEventListener("click", async () => {
  const raw = document.getElementById("global-storage-cap").value.trim();
  const cap = parseSize(raw);
  if (cap === null) { showToast('Invalid cap - use "500 GB"', "error"); return; }
  const resp = await apiFetch("/admin/storage", { method: "PATCH", json: { global_storage_quota_bytes: cap } });
  if (resp.ok) { showToast("Storage cap updated."); loadDetails(); loadDiskStats(); }
  else { const d = await resp.json().catch(() => ({})); showToast(d.detail || "Failed to update cap.", "error"); }
});

document.querySelectorAll("[data-lifecycle]").forEach(btn => {
  btn.addEventListener("click", async () => {
    btn.disabled = true;
    const resp = await apiFetch(btn.dataset.lifecycle, { method: "POST", json: {} });
    btn.disabled = false;
    if (!resp.ok) { showToast("Lifecycle action failed.", "error"); return; }
    const d = await resp.json();
    const msg = `Last run processed ${d.processed ?? 0} item(s).`;
    const out = document.getElementById("lifecycle-last-result");
    if (out) out.textContent = msg;
    showToast(msg);
    loadDetails();
    loadAdminFiles();
  });
});

// ── Users ─────────────────────────────────────────────────────────────────
const usersTbody = document.getElementById("users-tbody");
let usersCache = [];

// A compact permission badge: green when granted, faint gray when not.
function pBadge(label, on, tip) {
  const b = document.createElement("span");
  b.className = on ? "badge badge-green" : "badge badge-gray";
  b.style.opacity = on ? "1" : "0.5";
  b.textContent = label;
  setTooltip(b, tip);
  return b;
}

async function loadUsers() {
  usersTbody.textContent = "";
  const [usersResp, filesResp, dirsResp] = await Promise.all([
    apiFetch("/users/"),
    apiFetch("/admin/files"),
    apiFetch("/admin/directories"),
  ]);
  if (!usersResp.ok) { showToast("Failed to load users.", "error"); return; }
  const data = await usersResp.json();
  const needle = (document.getElementById("user-filter")?.value || "").trim().toLowerCase();
  const users = (data.users || []).filter(u => {
    if (!needle) return true;
    return [u.username, u.role, String(u.id)].some(v => (v || "").toLowerCase().includes(needle));
  });
  usersCache = data.users || [];

  // Per-owner storage rollup so each row can show usage against quota.
  const byOwner = {};
  if (filesResp.ok) {
    const { files } = await filesResp.json();
    for (const f of files) {
      const o = (byOwner[f.owner_id] ||= { count: 0, bytes: 0 });
      o.count++;
      o.bytes += f.stored_size_bytes ?? f.size_bytes ?? 0;
    }
  }
  if (dirsResp.ok) {
    const { directories } = await dirsResp.json();
    for (const d of directories) {
      const o = (byOwner[d.owner_id] ||= { count: 0, bytes: 0 });
      o.count += d.file_count || 0;
      o.bytes += d.total_bytes || 0;
    }
  }

  if (!users.length) {
    const row = document.createElement("tr");
    const td = document.createElement("td");
    td.colSpan = 7;
    td.className = "empty";
    td.textContent = "No users match the filter.";
    row.appendChild(td);
    usersTbody.appendChild(row);
    return;
  }

  for (const u of users) {
    const row = document.createElement("tr");
    const p = u.permissions || {};
    const stats = byOwner[u.id] || { count: 0, bytes: 0 };

    const td1 = document.createElement("td");
    const nameEl = document.createElement("span");
    nameEl.style.fontWeight = "500";
    nameEl.textContent = u.username;
    td1.appendChild(nameEl);
    if (u.must_change_credentials) {
      const b = document.createElement("span");
      b.className = "badge badge-orange"; b.style.marginLeft = "8px"; b.textContent = "setup pending";
      setTooltip(b, "This user must change their credentials before using the app.");
      td1.appendChild(b);
    }

    const td2 = document.createElement("td");
    const roleB = document.createElement("span");
    roleB.className = u.role === "master" ? "badge badge-orange" : "badge badge-gray";
    roleB.textContent = u.role;
    setTooltip(roleB, u.role === "master" ? "Master users bypass granular permissions." : "Regular user controlled by granular permissions.");
    td2.appendChild(roleB);

    // Permissions — one badge each, so admins see capabilities at a glance.
    const td3 = document.createElement("td");
    const badges = document.createElement("div");
    badges.style.cssText = "display:flex;gap:4px;flex-wrap:wrap";
    badges.append(
      pBadge("upload", !!p.can_upload, "Can upload files"),
      pBadge("e2e", !!p.can_upload_client_encrypted, "Can upload client-side (end-to-end) encrypted files"),
      pBadge("delete", !!p.can_delete, "Can delete own files"),
      pBadge("links", !!p.can_regenerate_links, "Can regenerate share links"),
      pBadge("link-del", !!p.can_delete_links, "Can permanently delete share links"),
      pBadge("folders", !!p.can_create_directories, "Can create folder shares"),
      pBadge("life", !!p.can_manage_lifecycle, "Can set lifecycle/archiving options"),
      pBadge("api", !!p.can_use_api_keys, "Can use API keys"),
    );
    td3.appendChild(badges);

    // Files count.
    const td4 = document.createElement("td");
    td4.className = "td-mono text-xs";
    td4.textContent = stats.count.toLocaleString();

    // Storage usage bar: used of quota.
    const td5 = document.createElement("td");
    const quota = p.quota_bytes ?? 0;
    const pct = quota > 0 ? Math.min(100, (stats.bytes / quota) * 100) : 0;
    const lbl = document.createElement("div");
    lbl.className = "text-xs text-muted";
    lbl.style.marginBottom = "3px";
    lbl.textContent = `${formatBytes(stats.bytes)} / ${quota ? formatBytes(quota) : "∞"}`;
    const storageBar = document.createElement("div");
    storageBar.className = "quota-bar";
    storageBar.style.maxWidth = "160px";
    const fill = document.createElement("div");
    fill.className = "quota-bar-fill" + (pct >= 90 ? " danger" : pct >= 70 ? " warn" : "");
    fill.style.width = pct.toFixed(1) + "%";
    storageBar.appendChild(fill);
    td5.append(lbl, storageBar);

    const td6 = document.createElement("td");
    td6.className = "text-xs text-muted";
    td6.textContent = formatDate(u.created_at);

    const td7 = document.createElement("td");
    const acts = document.createElement("div");
    acts.className = "td-actions";
    const permBtn = document.createElement("button");
    permBtn.className = "btn btn-ghost btn-sm";
    permBtn.textContent = "Permissions";
    setTooltip(permBtn, "Edit granular permissions, quota, and max file size for this user.");
    permBtn.addEventListener("click", () => openPermModal(u));
    const editBtn = document.createElement("button");
    editBtn.className = "btn btn-ghost btn-sm";
    editBtn.textContent = "Edit";
    setTooltip(editBtn, "Change username, password, or role.");
    editBtn.addEventListener("click", () => openEditUserModal(u));
    const delBtn = document.createElement("button");
    delBtn.className = "btn btn-danger btn-sm";
    delBtn.textContent = "Delete";
    setTooltip(delBtn, "Delete this user and their files, folders, API keys, and links.");
    delBtn.addEventListener("click", () => deleteUser(u.id, u.username));
    acts.append(editBtn, permBtn, delBtn);
    td7.appendChild(acts);

    row.append(td1, td2, td3, td4, td5, td6, td7);
    usersTbody.appendChild(row);
  }
}

// ── Edit user modal ───────────────────────────────────────────────────────
const editUserModal = document.getElementById("edit-user-modal");
const editUserAlert = document.getElementById("edit-user-alert");
const editUserSave = document.getElementById("edit-user-save");
let editUserId = null;

function openEditUserModal(u) {
  editUserId = u.id;
  editUserAlert.className = "alert hidden";
  document.getElementById("edit-user-current").textContent = u.username;
  document.getElementById("eu-username").value = u.username;
  document.getElementById("eu-password").value = "";
  document.getElementById("eu-role").value = u.role;
  editUserModal.classList.remove("hidden");
}

document.getElementById("edit-user-cancel").addEventListener("click", () => editUserModal.classList.add("hidden"));
editUserModal.addEventListener("click", e => { if (e.target === editUserModal) editUserModal.classList.add("hidden"); });

editUserSave.addEventListener("click", async () => {
  const body = {
    username: document.getElementById("eu-username").value.trim(),
    role: document.getElementById("eu-role").value,
  };
  const pw = document.getElementById("eu-password").value;
  if (pw) body.password = pw;
  if (!body.username) { showEditUserAlert("Username is required."); return; }
  if (pw && pw.length < 12) { showEditUserAlert("Password must be at least 12 characters."); return; }

  editUserSave.disabled = true;
  const resp = await apiFetch(`/users/${editUserId}`, { method: "PATCH", json: body });
  editUserSave.disabled = false;
  if (!resp.ok) {
    const d = await resp.json().catch(() => ({}));
    showEditUserAlert(d.detail || "Update failed.");
    return;
  }
  editUserModal.classList.add("hidden");
  showToast("User updated.");
  loadUsers();
});

function showEditUserAlert(msg) {
  editUserAlert.textContent = msg;
  editUserAlert.className = "alert alert-error";
}

async function deleteUser(id, username) {
  const ok = await showConfirm({
    title: "Delete user?",
    message: `"${username}" will be removed along with all their files, folders, API keys, and share links. This cannot be undone.`,
    confirmText: "Delete user",
    danger: true,
  });
  if (!ok) return;
  const resp = await apiFetch(`/users/${id}`, { method: "DELETE" });
  if (resp.ok) { showToast("User deleted."); loadUsers(); loadDiskStats(); }
  else { const d = await resp.json().catch(() => ({})); showToast(d.detail || "Delete failed.", "error"); }
}

// ── Create user modal ─────────────────────────────────────────────────────
const createModal   = document.getElementById("create-modal");
const createAlert   = document.getElementById("create-alert");
const createConfirm = document.getElementById("create-confirm");

document.getElementById("create-user-btn").addEventListener("click", () => {
  document.getElementById("cu-username").value = "";
  document.getElementById("cu-password").value = "";
  document.getElementById("cu-role").value = "user";
  document.getElementById("cu-can-upload").checked = true;
  createAlert.className = "alert hidden";
  createModal.classList.remove("hidden");
  setTimeout(() => document.getElementById("cu-username").focus(), 50);
});
document.getElementById("create-cancel").addEventListener("click", () => createModal.classList.add("hidden"));
createModal.addEventListener("click", e => { if (e.target === createModal) createModal.classList.add("hidden"); });

createConfirm.addEventListener("click", async () => {
  const username  = document.getElementById("cu-username").value.trim();
  const password  = document.getElementById("cu-password").value;
  const role      = document.getElementById("cu-role").value;
  const canUpload = document.getElementById("cu-can-upload").checked;
  if (!username) { showCreateAlert("Username is required."); return; }
  if (password.length < 12) { showCreateAlert("Password must be at least 12 characters."); return; }
  createConfirm.disabled = true;
  const resp = await apiFetch("/users/", { method: "POST", json: { username, password, role, can_upload: canUpload } });
  createConfirm.disabled = false;
  if (resp.status === 409) { showCreateAlert("Username already taken."); return; }
  if (!resp.ok) { const d = await resp.json().catch(() => ({})); showCreateAlert(d.detail || "Failed."); return; }
  createModal.classList.add("hidden");
  showToast(`User "${username}" created.`);
  loadUsers();
  loadDiskStats();
});
function showCreateAlert(msg) {
  createAlert.textContent = msg;
  createAlert.className = "alert alert-error";
}

// ── Permissions modal ─────────────────────────────────────────────────────
const permModal = document.getElementById("perm-modal");
const permAlert = document.getElementById("perm-alert");
const permSave  = document.getElementById("perm-save");
let permUserId  = null;

function openPermModal(u) {
  permUserId = u.id;
  document.getElementById("perm-username").textContent = u.username;
  permAlert.className = "alert hidden";
  const p = u.permissions || {};
  document.getElementById("perm-can-upload").checked = !!p.can_upload;
  document.getElementById("perm-can-client-enc").checked = !!p.can_upload_client_encrypted;
  document.getElementById("perm-can-delete").checked = !!p.can_delete;
  document.getElementById("perm-can-regen").checked  = !!p.can_regenerate_links;
  document.getElementById("perm-can-delete-links").checked = !!p.can_delete_links;
  document.getElementById("perm-can-folders").checked = !!p.can_create_directories;
  document.getElementById("perm-can-lifecycle").checked = !!p.can_manage_lifecycle;
  document.getElementById("perm-can-api").checked    = !!p.can_use_api_keys;
  document.getElementById("perm-can-p2p").checked    = !!p.can_use_p2p;
  document.getElementById("perm-can-view-admin").checked = !!p.can_view_admin;
  document.getElementById("perm-can-manage-users").checked = !!p.can_manage_users;
  document.getElementById("perm-can-manage-storage").checked = !!p.can_manage_storage;
  document.getElementById("perm-can-manage-api").checked = !!p.can_manage_api_keys;
  document.getElementById("perm-quota").value    = p.quota_bytes    != null ? formatBytes(p.quota_bytes)    : "";
  document.getElementById("perm-max-file").value = p.max_file_bytes != null ? formatBytes(p.max_file_bytes) : "";
  permModal.classList.remove("hidden");
}
document.getElementById("perm-cancel").addEventListener("click", () => permModal.classList.add("hidden"));
permModal.addEventListener("click", e => { if (e.target === permModal) permModal.classList.add("hidden"); });

permSave.addEventListener("click", async () => {
  const quotaStr   = document.getElementById("perm-quota").value.trim();
  const maxFileStr = document.getElementById("perm-max-file").value.trim();
  const quotaBytes   = parseSize(quotaStr);
  const maxFileBytes = parseSize(maxFileStr);
  if (quotaStr   && quotaBytes   === null) { showPermAlert('Invalid quota — use "100 GB"'); return; }
  if (maxFileStr && maxFileBytes === null) { showPermAlert('Invalid max file size — use "10 GB"'); return; }

  const body = {
    can_upload:                  document.getElementById("perm-can-upload").checked,
    can_upload_client_encrypted: document.getElementById("perm-can-client-enc").checked,
    can_delete:                  document.getElementById("perm-can-delete").checked,
    can_regenerate_links:        document.getElementById("perm-can-regen").checked,
    can_delete_links:            document.getElementById("perm-can-delete-links").checked,
    can_create_directories:      document.getElementById("perm-can-folders").checked,
    can_manage_lifecycle:        document.getElementById("perm-can-lifecycle").checked,
    can_use_api_keys:            document.getElementById("perm-can-api").checked,
    can_use_p2p:                 document.getElementById("perm-can-p2p").checked,
    can_view_admin:              document.getElementById("perm-can-view-admin").checked,
    can_manage_users:            document.getElementById("perm-can-manage-users").checked,
    can_manage_storage:          document.getElementById("perm-can-manage-storage").checked,
    can_manage_api_keys:         document.getElementById("perm-can-manage-api").checked,
  };
  if (quotaBytes   != null) body.quota_bytes    = quotaBytes;
  if (maxFileBytes != null) body.max_file_bytes = maxFileBytes;

  permSave.disabled = true;
  const resp = await apiFetch(`/users/${permUserId}/permissions`, { method: "POST", json: body });
  permSave.disabled = false;
  if (!resp.ok) {
    const d = await resp.json().catch(() => ({}));
    showPermAlert(d.detail || "Update failed.");
    return;
  }
  permModal.classList.add("hidden");
  showToast("Permissions updated.");
  loadUsers();
});
function showPermAlert(msg) {
  permAlert.textContent = msg;
  permAlert.className = "alert alert-error";
}

// ── Link edit modal ───────────────────────────────────────────────────────
const linkEditModal  = document.getElementById("link-edit-modal");
const linkEditAlert  = document.getElementById("link-edit-alert");
const leSave         = document.getElementById("le-save");
let linkEditId       = null;

function openLinkEditModal(lk) {
  linkEditId = lk.id;
  linkEditAlert.className = "alert hidden";
  document.getElementById("le-max-uses").value = lk.max_uses != null ? String(lk.max_uses) : "";
  document.getElementById("le-expires").value  = "";
  document.getElementById("le-active").checked = !!lk.active;
  linkEditModal.classList.remove("hidden");
  setTimeout(() => document.getElementById("le-max-uses").focus(), 50);
}
document.getElementById("le-cancel").addEventListener("click", () => linkEditModal.classList.add("hidden"));
linkEditModal.addEventListener("click", e => { if (e.target === linkEditModal) linkEditModal.classList.add("hidden"); });

leSave.addEventListener("click", async () => {
  const maxUsesRaw   = document.getElementById("le-max-uses").value.trim();
  const expiresRaw   = document.getElementById("le-expires").value.trim();
  const expiresInSec = expiresRaw ? parseDuration(expiresRaw) : null;
  const active       = document.getElementById("le-active").checked;

  if (expiresRaw && expiresInSec === null) {
    linkEditAlert.textContent = 'Invalid duration — use "7d", "24h"';
    linkEditAlert.className = "alert alert-error";
    return;
  }

  const body = { active };
  // Always send max_uses so empty field clears the limit (null = unlimited)
  body.max_uses = maxUsesRaw !== "" ? parseInt(maxUsesRaw, 10) : null;
  if (expiresInSec) body.expires_in_seconds = expiresInSec;

  leSave.disabled = true;
  const resp = await apiFetch(`/links/${linkEditId}`, { method: "PATCH", json: body });
  leSave.disabled = false;

  if (!resp.ok) {
    const d = await resp.json().catch(() => ({}));
    linkEditAlert.textContent = d.detail || "Update failed.";
    linkEditAlert.className = "alert alert-error";
    return;
  }
  linkEditModal.classList.add("hidden");
  showToast("Link updated.");
  loadAdminFiles();
});

// ── Admin files view ──────────────────────────────────────────────────────
const filesByUserEl = document.getElementById("files-by-user");
const selectedFiles = new Set();
const selectedDirectories = new Set();
const selectedKeys = new Set();

function selectionBox(kind, id, label) {
  const wrap = document.createElement("label");
  wrap.className = "select-cell custom-check";
  wrap.addEventListener("click", e => e.stopPropagation());
  const input = document.createElement("input");
  input.type = "checkbox";
  input.setAttribute("aria-label", label);
  setTooltip(wrap, label);
  const set = kind === "files" ? selectedFiles : kind === "directories" ? selectedDirectories : selectedKeys;
  input.checked = set.has(id);
  input.addEventListener("change", () => {
    if (input.checked) set.add(id);
    else set.delete(id);
    loadDangerZone();
    updateBulkBar();
  });
  const box = document.createElement("span");
  box.className = "custom-check-box";
  box.innerHTML = '<svg viewBox="0 0 10 8" xmlns="http://www.w3.org/2000/svg"><polyline points="1.5,4 4,6.5 8.5,1.5"/></svg>';
  wrap.append(input, box);
  return wrap;
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

function updateBulkBar() {
  const bar = document.getElementById("bulk-action-bar");
  if (!bar) return;
  const fileCount = selectedFiles.size;
  const dirCount = selectedDirectories.size;
  const keyCount = selectedKeys.size;
  const total = fileCount + dirCount + keyCount;
  bar.classList.toggle("visible", total > 0);
  document.getElementById("bulk-bar-count").textContent = total;
  const actionsEl = document.getElementById("bulk-bar-actions");
  actionsEl.textContent = "";
  const addBtn = (action, label, danger) => {
    const btn = document.createElement("button");
    btn.className = `btn-bulk ${danger ? "btn-bulk-danger" : "btn-bulk-neutral"}`;
    btn.textContent = label;
    btn.dataset.bulkAction = action;
    btn.addEventListener("click", () => runBulkAction(btn));
    actionsEl.appendChild(btn);
  };
  if (fileCount > 0) {
    addBtn("archive_files", "Archive", false);
    addBtn("unarchive_files", "Unarchive", false);
    addBtn("delete_files", "Delete files", true);
  }
  if (dirCount > 0) addBtn("delete_directories", "Delete folders", true);
  if (keyCount > 0) {
    addBtn("revoke_api_keys", "Revoke keys", true);
    addBtn("reset_api_key_ips", "Reset IPs", false);
  }
}

// Encryption badge for a file, or null when unencrypted.
function encBadgeEl(f) {
  if (f.encryption_mode === "client") {
    const b = document.createElement("span");
    b.className = "badge badge-orange";
    setTooltip(b, "End-to-end encrypted: the key lives only in the share link (#ek=), not recoverable server-side.");
    b.textContent = "🔒 e2e";
    return b;
  }
  if (f.encryption_mode === "server") {
    const b = document.createElement("span");
    b.className = "badge badge-orange";
    setTooltip(b, "Server-side encrypted: downloads require the recoverable ?ek= access key.");
    b.textContent = "🔐 server";
    return b;
  }
  return null;
}

// Full share URL for a link, appending the recoverable server-mode ?ek= key.
function adminLinkUrl(slug, f) {
  const base = `${location.origin}/file/${slug}`;
  if (f && f.encryption_mode === "server" && f.access_key) {
    return base + "?ek=" + encodeURIComponent(f.access_key);
  }
  return base;
}

function copyAdminText(text, btn) {
  navigator.clipboard.writeText(text).then(() => {
    if (!btn) return;
    const orig = btn.textContent;
    btn.textContent = "Copied!";
    setTimeout(() => (btn.textContent = orig), 1500);
  }).catch(() => {});
}

function adminDirectoryUrl(d) {
  let url = d.url || `${location.origin}/d/${d.slug}`;
  if (d.encryption_mode === "server" && d.access_key) {
    url += "?ek=" + encodeURIComponent(d.access_key);
  }
  return url;
}

async function loadAdminFiles() {
  filesByUserEl.textContent = "";
  const [usersResp, filesResp, dirsResp] = await Promise.all([
    apiFetch("/users/"),
    apiFetch("/admin/files"),
    apiFetch("/admin/directories"),
  ]);
  if (!usersResp.ok || !filesResp.ok || !dirsResp.ok) { filesByUserEl.textContent = "Failed to load."; return; }
  const { users } = await usersResp.json();
  let { files } = await filesResp.json();
  let { directories } = await dirsResp.json();

  const userMap = {};
  for (const u of users) userMap[u.id] = u;
  const needle = (document.getElementById("admin-file-filter")?.value || "").trim().toLowerCase();
  if (needle) {
    files = files.filter(f => {
      const owner = userMap[f.owner_id]?.username || "";
      return [f.original_filename, f.content_type, owner, String(f.id)]
        .some(v => (v || "").toLowerCase().includes(needle));
    });
    directories = directories.filter(d => {
      const owner = userMap[d.owner_id]?.username || "";
      return [d.title, d.slug, owner, String(d.id)]
        .some(v => (v || "").toLowerCase().includes(needle));
    });
  }

  if (!files.length && !directories.length) {
    const empty = document.createElement("div");
    empty.className = "empty";
    const ico = document.createElement("div");
    ico.className = "empty-icon";
    ico.textContent = "📂";
    empty.append(ico, "No files or folders yet.");
    filesByUserEl.appendChild(empty);
    return;
  }

  const sections = {};
  for (const d of directories) {
    const section = (sections[d.owner_id] ||= { files: [], directories: [] });
    section.directories.push(d);
  }
  for (const f of files) {
    const section = (sections[f.owner_id] ||= { files: [], directories: [] });
    section.files.push(f);
  }

  for (const [ownerId, ownerItems] of Object.entries(sections)) {
    const ownerFiles = ownerItems.files;
    const ownerDirs = ownerItems.directories;
    const owner   = userMap[ownerId];
    const section = document.createElement("div");
    section.className = "user-section";

    const header = document.createElement("div");
    header.className = "user-section-header";
    const nameEl = document.createElement("span");
    nameEl.className = "user-section-name";
    nameEl.textContent = owner ? owner.username : `User #${ownerId}`;
    const countBadge = document.createElement("span");
    countBadge.className = "badge badge-gray";
    countBadge.textContent = `${ownerFiles.length} file${ownerFiles.length !== 1 ? "s" : ""}`;
    setTooltip(countBadge, "Loose files owned by this user.");
    const folderBadge = document.createElement("span");
    folderBadge.className = "badge badge-green";
    folderBadge.textContent = `${ownerDirs.length} folder${ownerDirs.length !== 1 ? "s" : ""}`;
    setTooltip(folderBadge, "Shareable folders owned by this user.");
    const sizeBadge = document.createElement("span");
    sizeBadge.className = "text-xs text-muted";
    sizeBadge.textContent = formatBytes(
      ownerFiles.reduce((a, f) => a + f.size_bytes, 0) +
      ownerDirs.reduce((a, d) => a + (d.total_bytes || 0), 0)
    );
    header.append(nameEl, countBadge, folderBadge, sizeBadge);
    section.appendChild(header);

    const card = document.createElement("div");
    card.className = "card";
    card.style.padding = "0";

    for (const d of ownerDirs) {
      const row = document.createElement("div");
      row.className = "file-row";

      const nameDiv = document.createElement("div");
      nameDiv.className = "file-row-name";
      nameDiv.textContent = `📁 ${d.title}`;
      nameDiv.title = d.title;

      const sizeDiv = document.createElement("div");
      sizeDiv.className = "file-row-size";
      sizeDiv.textContent = formatBytes(d.total_bytes || 0);

      const dateDiv = document.createElement("div");
      dateDiv.className = "file-meta";
      dateDiv.style.fontSize = "11px";
      dateDiv.textContent = formatDate(d.created_at);

      const typeDiv = document.createElement("div");
      typeDiv.className = "text-xs text-muted";
      typeDiv.textContent = "folder";

      const fc = document.createElement("span");
      fc.className = "badge badge-gray";
      fc.textContent = `${d.file_count} file${d.file_count !== 1 ? "s" : ""}`;

      const enc = encBadgeEl(d);

      const openBtn = document.createElement("button");
      openBtn.className = "btn btn-ghost btn-sm";
      openBtn.textContent = "Open";
      setTooltip(openBtn, "Open this shared folder page in a new tab.");
      openBtn.addEventListener("click", () => window.open(adminDirectoryUrl(d), "_blank", "noopener"));

      const copyBtn = document.createElement("button");
      copyBtn.className = "btn btn-ghost btn-sm";
      copyBtn.textContent = "Copy";
      setTooltip(copyBtn, "Open share options for this folder.");
      copyBtn.addEventListener("click", () => showCopyModal(adminDirectoryUrl(d), d.title, {
        hint: d.encryption_mode === "client"
          ? "🔒 End-to-end encrypted — the #ek= key is embedded in this URL."
          : d.encryption_mode === "server"
          ? "🔐 Server-encrypted — the ?ek= access key is embedded in this URL."
          : "",
      }));

      const delBtn = document.createElement("button");
      delBtn.className = "btn btn-danger btn-sm";
      delBtn.textContent = "Delete all";
      setTooltip(delBtn, "Permanently delete this folder and every file inside it.");
      delBtn.addEventListener("click", () => deleteAdminDirectory(d.id, d.title, d.file_count));

      row.append(selectionBox("directories", d.id, `Select folder ${d.title} for Danger Zone actions`), nameDiv, sizeDiv, dateDiv, typeDiv, fc);
      if (enc) row.append(enc);
      row.append(openBtn, copyBtn, delBtn);
      card.appendChild(row);
    }

    for (const f of ownerFiles) {
      // File row (clickable to expand links)
      const fileWrap = document.createElement("div");

      const row = document.createElement("div");
      row.className = "file-row";
      row.title = "Click to expand links";

      const nameDiv = document.createElement("div");
      nameDiv.className = "file-row-name";
      nameDiv.textContent = f.original_filename;
      nameDiv.title = f.original_filename;

      const sizeDiv = document.createElement("div");
      sizeDiv.className = "file-row-size";
      sizeDiv.textContent = formatBytes(f.size_bytes);

      const dateDiv = document.createElement("div");
      dateDiv.className = "file-meta";
      dateDiv.style.fontSize = "11px";
      dateDiv.textContent = formatDate(f.created_at);

      const typeDiv = document.createElement("div");
      typeDiv.className = "text-xs text-muted";
      typeDiv.style.maxWidth = "120px";
      typeDiv.style.overflow = "hidden";
      typeDiv.style.textOverflow = "ellipsis";
      typeDiv.style.whiteSpace = "nowrap";
      typeDiv.textContent = f.content_type || "";

      const enc = encBadgeEl(f);

      const cmp = document.createElement("span");
      if (f.compressed) { cmp.className = "badge badge-gray"; cmp.textContent = "zst"; setTooltip(cmp, "Stored compressed."); }

      const dlDiv = document.createElement("div");
      dlDiv.className = "text-xs text-muted";
      dlDiv.style.whiteSpace = "nowrap";
      setTooltip(dlDiv, "Last downloaded timestamp.");
      dlDiv.textContent = f.last_downloaded_at ? `↓ ${formatDate(f.last_downloaded_at)}` : "never dl";

      const activeLinks = f.links.filter(l => l.active).length;
      const linksBadge = document.createElement("span");
      linksBadge.className = activeLinks > 0 ? "badge badge-green" : "badge badge-gray";
      linksBadge.textContent = `${activeLinks}/${f.links.length} links`;
      setTooltip(linksBadge, "Active links over total links for this file.");

      const expandBtn = document.createElement("button");
      expandBtn.className = "file-expand-btn";
      expandBtn.textContent = "▶ Links";
      setTooltip(expandBtn, "Show or hide links for this file.");

      const delBtn = document.createElement("button");
      delBtn.className = "btn btn-danger btn-sm";
      delBtn.textContent = "Delete";
      setTooltip(delBtn, "Permanently delete this file and all of its links.");
      delBtn.addEventListener("click", e => { e.stopPropagation(); deleteAdminFile(f.id, f.original_filename); });

      const archiveBtn = document.createElement("button");
      archiveBtn.className = "btn btn-ghost btn-sm";
      archiveBtn.textContent = f.archived ? "Unarchive" : "Archive";
      setTooltip(archiveBtn, f.archived ? "Restore this archived file after quota and disk checks." : "Archive/compress this file to save storage.");
      archiveBtn.addEventListener("click", e => {
        e.stopPropagation();
        toggleArchiveFile(f.id, f.archived);
      });

      row.append(selectionBox("files", f.id, `Select file ${f.original_filename} for Danger Zone actions`), nameDiv, sizeDiv, dateDiv, typeDiv);
      if (enc) row.append(enc);
      if (f.compressed) row.append(cmp);
      row.append(dlDiv, linksBadge, expandBtn, archiveBtn, delBtn);

      // Expandable link panel
      const expandBody = document.createElement("div");
      expandBody.className = "file-expand-body file-links-panel";

      let expanded = false;

      function toggleExpand() {
        expanded = !expanded;
        expandBody.classList.toggle("open", expanded);
        expandBtn.textContent = expanded ? "▼ Links" : "▶ Links";
        if (expanded && !expandBody.childElementCount) {
          buildLinkPanel(expandBody, f);
        }
      }

      row.addEventListener("click", e => {
        if (e.target.closest("button,a,input")) return;
        toggleExpand();
      });
      expandBtn.addEventListener("click", e => { e.stopPropagation(); toggleExpand(); });

      fileWrap.appendChild(row);
      fileWrap.appendChild(expandBody);
      card.appendChild(fileWrap);
    }

    section.appendChild(card);
    filesByUserEl.appendChild(section);
  }
}

function buildLinkPanel(container, f) {
  container.textContent = "";

  const mintBtn = document.createElement("button");
  mintBtn.className = "btn btn-ghost btn-sm";
  mintBtn.style.margin = "8px 0 4px";
  mintBtn.textContent = "+ New link";
  setTooltip(mintBtn, "Create an additional share link for this file.");
  mintBtn.addEventListener("click", async () => {
    const resp = await apiFetch(`/files/${f.id}/links`, { method: "POST", json: {} });
    if (!resp.ok) { showToast("Failed to create link.", "error"); return; }
    const data = await resp.json();
    const url = adminLinkUrl(data.slug, f);
    showToast(f.encryption_mode === "client"
      ? "Link created — append the #ek= key before sharing."
      : "Link created & copied.");
    navigator.clipboard.writeText(url).catch(() => {});
    loadAdminFiles();
  });
  container.appendChild(mintBtn);

  if (!f.links.length) {
    const empty = document.createElement("div");
    empty.style.cssText = "padding:4px 0 6px;font-size:12px;color:var(--text-muted)";
    empty.textContent = "No links yet — create one above.";
    container.appendChild(empty);
    return;
  }

  const now = Date.now();
  for (const lk of f.links) {
    const expired  = lk.expires_at && new Date(lk.expires_at).getTime() < now;
    const usedUp   = lk.max_uses != null && lk.use_count >= lk.max_uses;
    const inactive = !lk.active || expired || usedUp;

    const lrow = document.createElement("div");
    lrow.className = "file-link-row";

    const dot = document.createElement("span");
    dot.className = "file-link-dot";
    dot.style.background = inactive ? "var(--text-muted)" : "var(--success)";

    const url = adminLinkUrl(lk.slug, f);
    const slugSpan = document.createElement("span");
    slugSpan.className = "file-link-slug";
    slugSpan.textContent = url;
    slugSpan.title = url;

    let clientWarn = null;
    if (f.encryption_mode === "client") {
      clientWarn = document.createElement("span");
      clientWarn.className = "badge badge-orange";
      clientWarn.title = "Append the #ek= key captured at upload — it is not stored server-side";
      clientWarn.textContent = "needs #ek=";
    }

    const uses = document.createElement("span");
    uses.className = "file-link-meta";
    uses.textContent = lk.max_uses != null ? `${lk.use_count}/${lk.max_uses} dl` : `${lk.use_count} dl`;

    const exp = document.createElement("span");
    exp.className = "file-link-meta";
    exp.textContent = lk.expires_at ? new Date(lk.expires_at).toLocaleDateString() : "no expiry";

    if (inactive) {
      const badge = document.createElement("span");
      badge.className = "badge badge-gray";
      badge.textContent = !lk.active ? "inactive" : expired ? "expired" : "used up";

      lrow.append(dot, slugSpan, ...(clientWarn ? [clientWarn] : []), uses, exp, badge);

      const copyBtn = document.createElement("button");
      copyBtn.className = "btn btn-ghost btn-sm";
      copyBtn.textContent = "Copy";
      setTooltip(copyBtn, "Open share options for this link.");
      copyBtn.addEventListener("click", () => showCopyModal(url, f.original_filename, {
        key: f.encryption_mode === "server" && f.access_key ? f.access_key : "",
        keyLabel: f.encryption_mode === "server" ? "Access key (?ek=)" : "",
        keyHint: f.encryption_mode === "server" && f.access_key ? "🔐 Server-encrypted — this key is required to download." : "",
        hint: f.encryption_mode === "client" ? "🔒 End-to-end encrypted — key not stored server-side. Append #ek= before sharing." : "",
      }));
      const openBtn = document.createElement("button");
      openBtn.className = "btn btn-ghost btn-sm";
      openBtn.textContent = "Open";
      setTooltip(openBtn, "Open this link in a new tab.");
      openBtn.addEventListener("click", () => window.open(url, "_blank", "noopener"));
      lrow.append(copyBtn, openBtn);

      if (!lk.active && !expired && !usedUp) {
        const reactBtn = document.createElement("button");
        reactBtn.className = "btn btn-ghost btn-sm";
        reactBtn.textContent = "Reactivate";
        setTooltip(reactBtn, "Make this manually deactivated link usable again.");
        reactBtn.addEventListener("click", async () => {
          const resp = await apiFetch(`/links/${lk.id}`, { method: "PATCH", json: { active: true } });
          if (resp.ok) { showToast("Link reactivated."); loadAdminFiles(); }
          else showToast("Failed to reactivate.", "error");
        });
        lrow.append(reactBtn);
      }

      const delLinkBtn = document.createElement("button");
      delLinkBtn.className = "btn btn-ghost btn-sm";
      delLinkBtn.style.color = "var(--danger)";
      delLinkBtn.textContent = "Delete";
      setTooltip(delLinkBtn, "Permanently delete this share link. The file remains stored.");
      delLinkBtn.addEventListener("click", () => deleteAdminLink(lk.id));
      lrow.append(delLinkBtn);
    } else {
      const copyBtn = document.createElement("button");
      copyBtn.className = "btn btn-ghost btn-sm";
      copyBtn.textContent = "Copy";
      setTooltip(copyBtn, "Open share options for this link.");
      copyBtn.addEventListener("click", () => showCopyModal(url, f.original_filename, {
        key: f.encryption_mode === "server" && f.access_key ? f.access_key : "",
        keyLabel: f.encryption_mode === "server" ? "Access key (?ek=)" : "",
        keyHint: f.encryption_mode === "server" && f.access_key ? "🔐 Server-encrypted — this key is required to download." : "",
        hint: f.encryption_mode === "client" ? "🔒 End-to-end encrypted — key not stored server-side. Append #ek= before sharing." : "",
      }));

      const openBtn = document.createElement("button");
      openBtn.className = "btn btn-ghost btn-sm";
      openBtn.textContent = "Open";
      setTooltip(openBtn, "Open this link in a new tab.");
      openBtn.addEventListener("click", () => window.open(url, "_blank", "noopener"));

      const editBtn = document.createElement("button");
      editBtn.className = "btn btn-ghost btn-sm";
      editBtn.textContent = "Edit";
      setTooltip(editBtn, "Edit link download limits, expiry, or active state.");
      editBtn.addEventListener("click", () => openLinkEditModal(lk));

      const deactBtn = document.createElement("button");
      deactBtn.className = "btn btn-ghost btn-sm";
      deactBtn.textContent = "Deactivate";
      setTooltip(deactBtn, "Disable this link without deleting the link row.");
      deactBtn.addEventListener("click", async () => {
        const resp = await apiFetch(`/links/${lk.id}`, { method: "PATCH", json: { active: false } });
        if (resp.ok) { showToast("Link deactivated."); loadAdminFiles(); }
        else showToast("Failed.", "error");
      });

      const delLinkBtn = document.createElement("button");
      delLinkBtn.className = "btn btn-ghost btn-sm";
      delLinkBtn.style.color = "var(--danger)";
      delLinkBtn.textContent = "Delete";
      setTooltip(delLinkBtn, "Permanently delete this share link. The file remains stored.");
      delLinkBtn.addEventListener("click", () => deleteAdminLink(lk.id));

      lrow.append(dot, slugSpan, ...(clientWarn ? [clientWarn] : []), uses, exp, copyBtn, openBtn, editBtn, deactBtn, delLinkBtn);
    }

    container.appendChild(lrow);
  }
}

async function deleteAdminLink(id) {
  const ok = await showConfirm({
    title: "Delete link?",
    message: "This permanently removes the share link. The file remains stored.",
    confirmText: "Delete link",
    danger: true,
  });
  if (!ok) return;
  const resp = await apiFetch(`/links/${id}`, { method: "DELETE" });
  if (resp.ok) { showToast("Link deleted."); loadAdminFiles(); loadDiskStats(); }
  else { const d = await resp.json().catch(() => ({})); showToast(d.detail || "Failed to delete link.", "error"); }
}

async function deleteAdminFile(id, name) {
  const ok = await showConfirm({
    title: "Delete file?",
    message: `"${name}" and all its links will be permanently removed. This cannot be undone.`,
    confirmText: "Delete",
    danger: true,
  });
  if (!ok) return;
  const resp = await apiFetch(`/files/${id}`, { method: "DELETE" });
  if (resp.ok) { showToast("File deleted."); loadAdminFiles(); loadDiskStats(); }
  else { const d = await resp.json().catch(() => ({})); showToast(d.detail || "Delete failed.", "error"); }
}

async function toggleArchiveFile(id, archived) {
  const endpoint = archived ? "unarchive" : "archive";
  const resp = await apiFetch(`/admin/files/${id}/${endpoint}`, { method: "POST", json: {} });
  if (resp.ok) {
    const d = await resp.json();
    showToast(archived
      ? "File unarchived."
      : `File archived. Saved ${formatBytes(d.archive_saved_bytes || 0)}.`);
    loadAdminFiles();
    loadDiskStats();
    loadDetails();
  } else {
    const d = await resp.json().catch(() => ({}));
    showToast(d.detail || "Archive action failed.", "error");
  }
}

async function deleteAdminDirectory(id, title, count) {
  const ok = await showConfirm({
    title: "Delete folder?",
    message: `"${title}" and all ${count} file${count !== 1 ? "s" : ""} inside will be permanently removed. This cannot be undone.`,
    confirmText: "Delete folder",
    danger: true,
  });
  if (!ok) return;
  const resp = await apiFetch(`/directories/${id}`, { method: "DELETE" });
  if (resp.ok) { showToast("Folder deleted."); loadAdminFiles(); loadDiskStats(); }
  else { const d = await resp.json().catch(() => ({})); showToast(d.detail || "Delete failed.", "error"); }
}

// ── Danger zone ───────────────────────────────────────────────────────────
const BULK_META = {
  delete_inactive_links: {
    title: "Delete inactive links",
    noun: "link",
    description: "Inactive, expired, and used-up links will be permanently removed. Files remain stored.",
  },
  revoke_api_keys: {
    title: "Revoke API keys",
    noun: "API key",
    description: "Selected active keys are used when any are checked; otherwise all active keys are previewed.",
  },
  reset_api_key_ips: {
    title: "Reset key IP bindings",
    noun: "API key",
    description: "Selected bound keys are used when any are checked; otherwise all bound keys are previewed.",
  },
  archive_files: {
    title: "Archive selected files",
    noun: "file",
    selectedKind: "files",
    description: "Selected eligible files will be archived/compressed.",
  },
  unarchive_files: {
    title: "Unarchive selected files",
    noun: "file",
    selectedKind: "files",
    description: "Selected archived files will be restored after quota and disk checks.",
  },
  delete_files: {
    title: "Delete selected files",
    noun: "file",
    selectedKind: "files",
    description: "Selected files and their links will be permanently removed.",
  },
  delete_directories: {
    title: "Delete selected folders",
    noun: "folder",
    selectedKind: "directories",
    description: "Selected folders and every file inside them will be permanently removed.",
  },
  run_cleanup_jobs: {
    title: "Run cleanup jobs",
    noun: "job",
    description: "Temp expiry, idle deletion, link expiry, and lifecycle reconciliation will run now.",
  },
};

function idsForBulkAction(action) {
  const meta = BULK_META[action] || {};
  if (meta.selectedKind === "files") return [...selectedFiles];
  if (meta.selectedKind === "directories") return [...selectedDirectories];
  if (["revoke_api_keys", "reset_api_key_ips"].includes(action) && selectedKeys.size) return [...selectedKeys];
  return [];
}

function loadDangerZone() {
  document.querySelectorAll(".tab-panel [data-bulk-action]").forEach(btn => {
    const meta = BULK_META[btn.dataset.bulkAction] || {};
    const ids = idsForBulkAction(btn.dataset.bulkAction);
    const requiresSelection = !!meta.selectedKind;
    btn.disabled = requiresSelection && !ids.length;
    const sub = btn.querySelector(".action-card-sub");
    if (sub && requiresSelection) {
      const label = meta.selectedKind === "directories" ? "folder" : "file";
      sub.textContent = ids.length
        ? `${ids.length} ${label}${ids.length !== 1 ? "s" : ""} selected.`
        : `No ${label}s selected.`;
    }
  });
  updateBulkBar();
}

function renderDangerResult(title, processed, affected) {
  const el = document.getElementById("danger-result");
  el.textContent = "";
  el.classList.remove("hidden");
  const heading = document.createElement("div");
  heading.className = "dashboard-card-title";
  heading.textContent = title;
  const body = document.createElement("div");
  body.className = "text-sm text-muted";
  body.textContent = `Processed ${processed} of ${affected} previewed item(s).`;
  el.append(heading, body);
}

async function runBulkAction(btn) {
  const action = btn.dataset.bulkAction;
  const meta = BULK_META[action];
  const ids = idsForBulkAction(action);
  if (meta?.selectedKind && !ids.length) {
    showToast("Select rows in the Files tab first.", "error");
    return;
  }

  btn.disabled = true;
  const previewResp = await apiFetch("/admin/bulk/preview", { method: "POST", json: { action, ids } });
  btn.disabled = false;
  if (!previewResp.ok) {
    const d = await previewResp.json().catch(() => ({}));
    showToast(d.detail || "Bulk preview failed.", "error");
    return;
  }
  const preview = await previewResp.json();
  if (!preview.affected_count) {
    showToast("No matching records for that bulk action.");
    return;
  }

  const phrase = preview.confirmation_phrase;
  const typed = await showPrompt({
    title: meta.title,
    message: `${meta.description}\n\nThis will affect ${preview.affected_count} ${meta.noun}${preview.affected_count !== 1 ? "s" : ""}. Type ${phrase} to run it.`,
    placeholder: phrase,
    confirmText: "Run action",
    glyph: "!",
  });
  if (typed === null) return;
  if (typed !== phrase) {
    showToast("Confirmation phrase did not match.", "error");
    return;
  }

  btn.disabled = true;
  const runResp = await apiFetch("/admin/bulk/run", { method: "POST", json: { action, ids, confirm: phrase } });
  btn.disabled = false;
  if (!runResp.ok) {
    const d = await runResp.json().catch(() => ({}));
    showToast(d.detail || "Bulk action failed.", "error");
    return;
  }
  const result = await runResp.json();
  renderDangerResult(meta.title, result.processed_count, result.affected_count);
  showToast(`${meta.title}: processed ${result.processed_count}.`);
  if (["delete_files", "archive_files", "unarchive_files"].includes(action)) selectedFiles.clear();
  if (action === "delete_directories") selectedDirectories.clear();
  if (["revoke_api_keys", "reset_api_key_ips"].includes(action)) selectedKeys.clear();
  loadDangerZone();
  loadDiskStats();
  loadDetails();
  loadAdminFiles();
  loadKeys();
}

document.querySelectorAll("[data-bulk-action]").forEach(btn => {
  btn.addEventListener("click", () => runBulkAction(btn));
});

// ── Backend logs ──────────────────────────────────────────────────────────
let backendLogTimer = null;
let backendLogSearchTimer = null;

function backendTabActive() {
  return document.querySelector(".tab.active")?.dataset.tab === "backend";
}

function syncBackendAutoRefresh() {
  if (backendLogTimer) {
    clearInterval(backendLogTimer);
    backendLogTimer = null;
  }
  const auto = document.getElementById("backend-auto-refresh");
  if (backendTabActive() && auto?.checked) {
    backendLogTimer = setInterval(loadBackendLogs, 3000);
  }
}

function renderBackendLogs(data) {
  const list = document.getElementById("backend-log-list");
  const status = document.getElementById("backend-log-status");
  list.textContent = "";
  const filtered = Number(data.filtered_count || 0);
  const total = Number(data.total_count || 0);
  status.textContent = `${filtered.toLocaleString()} shown / ${total.toLocaleString()} captured`;

  const entries = data.entries || [];
  if (!entries.length) {
    const empty = document.createElement("div");
    empty.className = "empty";
    empty.textContent = "No backend logs match the filters.";
    list.appendChild(empty);
    return;
  }

  for (const entry of entries) {
    const row = document.createElement("div");
    row.className = "backend-log-row";
    setTooltip(row, `${entry.module || entry.logger}:${entry.line || "?"} ${entry.function || ""}`.trim());

    const time = document.createElement("div");
    time.className = "backend-log-time";
    time.textContent = formatDate(entry.created_at);

    const level = document.createElement("div");
    level.className = `backend-level ${(entry.level || "").toLowerCase()}`;
    level.textContent = entry.level || "INFO";

    const name = document.createElement("div");
    name.className = "backend-log-name";
    name.textContent = entry.logger || "app";

    const message = document.createElement("div");
    message.className = "backend-log-message";
    message.textContent = entry.message || "";

    row.append(time, level, name, message);
    list.appendChild(row);
  }
}

async function loadBackendLogs() {
  const params = new URLSearchParams({ limit: "300" });
  const q = document.getElementById("backend-log-filter")?.value.trim();
  const level = document.getElementById("backend-log-level")?.value;
  if (q) params.set("q", q);
  if (level) params.set("level", level);
  const resp = await apiFetch(`/admin/backend/logs?${params.toString()}`);
  if (!resp.ok) { showToast("Failed to load backend logs.", "error"); return; }
  renderBackendLogs(await resp.json());
}

async function restartBackendWorkers() {
  const ok = await showConfirm({
    title: "Restart backend workers?",
    message: "This restarts the background scheduler jobs for lifecycle scans, cleanup, link expiry, and stale upload cleanup. Active HTTP requests are not restarted.",
    confirmText: "Restart workers",
    danger: true,
  });
  if (!ok) return;
  const btn = document.getElementById("backend-restart-workers");
  btn.disabled = true;
  const resp = await apiFetch("/admin/backend/restart-workers", { method: "POST", json: {} });
  btn.disabled = false;
  if (!resp.ok) {
    const d = await resp.json().catch(() => ({}));
    showToast(d.detail || "Failed to restart backend workers.", "error");
    return;
  }
  const d = await resp.json();
  showToast(`Backend workers ${d.status}.`);
  loadBackendLogs();
}

// ── Audit log ─────────────────────────────────────────────────────────────
const auditTbody = document.getElementById("audit-tbody");
const LIMIT = 50;
let auditOffset = 0;
let auditEntries = [];
let auditTotalCount = 0;
let auditFilteredCount = 0;
let auditSearchTimer = null;

// Color the action by what it did: green=created, red=destructive, orange=mutated.
function actionBadgeClass(action) {
  if (/(deleted|deactivat|revoked|broken|failed)/i.test(action)) return "badge badge-red";
  if (/(created|uploaded|added|login)/i.test(action))            return "badge badge-green";
  if (/(updated|edited|changed|reset)/i.test(action))            return "badge badge-orange";
  return "badge badge-gray";
}

function renderAudit() {
  auditTbody.textContent = "";

  if (!auditEntries.length) {
    const r = document.createElement("tr");
    const td = document.createElement("td");
    td.colSpan = 6; td.className = "empty";
    td.textContent = auditFilteredCount ? "No entries on this page." : "No audit entries match the filters.";
    r.appendChild(td);
    auditTbody.appendChild(r);
    document.getElementById("audit-page").textContent =
      auditTotalCount ? `0 of ${auditFilteredCount.toLocaleString()} filtered (${auditTotalCount.toLocaleString()} total)` : "No audit entries";
    return;
  }

  for (const e of auditEntries) {
    const row = document.createElement("tr");

    const idTd = document.createElement("td");
    idTd.className = "td-mono"; idTd.textContent = String(e.id);

    const actorTd = document.createElement("td");
    actorTd.className = "td-mono"; actorTd.textContent = e.actor;

    const actionTd = document.createElement("td");
    const ab = document.createElement("span");
    ab.className = actionBadgeClass(e.action);
    ab.textContent = e.action;
    setTooltip(ab, "Audit action recorded by the server.");
    actionTd.appendChild(ab);

    const targetTd = document.createElement("td");
    targetTd.className = "text-xs text-muted"; targetTd.textContent = e.target || "–";

    const ipTd = document.createElement("td");
    ipTd.className = "td-mono text-xs"; ipTd.textContent = e.ip || "–";

    const timeTd = document.createElement("td");
    timeTd.className = "text-xs text-muted"; timeTd.textContent = formatDate(e.created_at);

    row.append(idTd, actorTd, actionTd, targetTd, ipTd, timeTd);
    auditTbody.appendChild(row);
  }

  const start = auditOffset + 1;
  const end = auditOffset + auditEntries.length;
  const filtered = auditFilteredCount.toLocaleString();
  const total = auditTotalCount.toLocaleString();
  document.getElementById("audit-page").textContent =
    auditFilteredCount === auditTotalCount
      ? `${start}–${end} of ${filtered}`
      : `${start}–${end} of ${filtered} filtered (${total} total)`;
}

async function loadAudit() {
  auditTbody.textContent = "";
  const loadRow = document.createElement("tr");
  const loadTd  = document.createElement("td");
  loadTd.colSpan = 6; loadTd.className = "empty"; loadTd.textContent = "Loading…";
  loadRow.appendChild(loadTd);
  auditTbody.appendChild(loadRow);

  const params = new URLSearchParams({ limit: String(LIMIT), offset: String(auditOffset) });
  const q = document.getElementById("audit-filter")?.value.trim();
  const action = document.getElementById("audit-action-filter")?.value;
  if (q) params.set("q", q);
  if (action) params.set("action", action);

  const resp = await apiFetch(`/audit/?${params.toString()}`);
  if (!resp.ok) { showToast("Failed to load audit log.", "error"); return; }
  const { entries, chain_ok, actions, total_count, filtered_count } = await resp.json();
  auditEntries = entries;
  auditTotalCount = Number(total_count || 0);
  auditFilteredCount = Number(filtered_count || 0);

  const integrity = document.getElementById("audit-integrity");
  const badge = document.getElementById("audit-integrity-badge");
  const text = document.getElementById("audit-integrity-text");
  integrity.classList.remove("hidden");
  badge.className = chain_ok ? "badge badge-green" : "badge badge-red";
  badge.textContent = chain_ok ? "verified" : "broken";
  setTooltip(badge, chain_ok
    ? "The audit hash chain is intact; existing entries have not been edited or removed."
    : "The audit hash chain failed verification; entries may have been edited or removed.");
  text.textContent = chain_ok
    ? "Audit log integrity is verified."
    : "Audit log integrity failed. Treat the log as potentially tampered until investigated.";

  // Refresh the action dropdown from the full server-side action catalog.
  const sel = document.getElementById("audit-action-filter");
  const current = sel.value;
  sel.textContent = "";
  const optAll = document.createElement("option");
  optAll.value = ""; optAll.textContent = "All actions";
  sel.appendChild(optAll);
  for (const a of (actions || [])) {
    const o = document.createElement("option");
    o.value = a; o.textContent = a;
    sel.appendChild(o);
  }
  if ((actions || []).includes(current)) sel.value = current;

  renderAudit();
  document.getElementById("audit-prev").disabled = auditOffset === 0;
  document.getElementById("audit-next").disabled = auditOffset + entries.length >= auditFilteredCount;
}

document.getElementById("audit-prev").addEventListener("click", () => { auditOffset = Math.max(0, auditOffset - LIMIT); loadAudit(); });
document.getElementById("audit-next").addEventListener("click", () => { auditOffset += LIMIT; loadAudit(); });
document.getElementById("audit-filter").addEventListener("input", () => {
  clearTimeout(auditSearchTimer);
  auditSearchTimer = setTimeout(() => {
    auditOffset = 0;
    loadAudit();
  }, 220);
});
document.getElementById("audit-action-filter").addEventListener("change", () => {
  auditOffset = 0;
  loadAudit();
});
document.getElementById("audit-clear").addEventListener("click", () => {
  document.getElementById("audit-filter").value = "";
  document.getElementById("audit-action-filter").value = "";
  auditOffset = 0;
  loadAudit();
});
document.getElementById("audit-refresh").addEventListener("click", loadAudit);

document.getElementById("user-filter").addEventListener("input", loadUsers);
document.getElementById("admin-file-filter").addEventListener("input", loadAdminFiles);
document.getElementById("clear-file-selection").addEventListener("click", () => {
  selectedFiles.clear();
  selectedDirectories.clear();
  loadDangerZone();
  loadAdminFiles();
});
document.getElementById("bulk-bar-clear").addEventListener("click", () => {
  selectedFiles.clear();
  selectedDirectories.clear();
  selectedKeys.clear();
  loadDangerZone();
  loadAdminFiles();
  loadKeys();
});
document.getElementById("key-filter").addEventListener("input", loadKeys);
document.getElementById("key-status-filter").addEventListener("change", loadKeys);
document.getElementById("backend-refresh").addEventListener("click", loadBackendLogs);
document.getElementById("backend-restart-workers").addEventListener("click", restartBackendWorkers);
document.getElementById("backend-log-level").addEventListener("change", loadBackendLogs);
document.getElementById("backend-auto-refresh").addEventListener("change", syncBackendAutoRefresh);
document.getElementById("backend-log-filter").addEventListener("input", () => {
  clearTimeout(backendLogSearchTimer);
  backendLogSearchTimer = setTimeout(loadBackendLogs, 220);
});

loadDiskStats();
loadUsers();
loadDangerZone();
syncBackendAutoRefresh();


// ── API Keys tab ────────────────────────────────────────────────────────────

async function loadKeys() {
  const resp = await apiFetch('/admin/keys');
  if (!resp.ok) { showToast('Failed to load API keys.', 'error'); return; }
  const data = await resp.json();
  const list = document.getElementById('keys-list');
  list.textContent = '';

  const allKeys = data.keys || [];
  const liveKeyIds = new Set(allKeys.map(k => k.id));
  for (const id of [...selectedKeys]) {
    if (!liveKeyIds.has(id)) selectedKeys.delete(id);
  }

  const keyNeedle = (document.getElementById("key-filter")?.value || "").trim().toLowerCase();
  const keyStatus = document.getElementById("key-status-filter")?.value || "";
  const keys = allKeys.filter(k => {
    if (keyStatus === "active" && !k.active) return false;
    if (keyStatus === "inactive" && k.active) return false;
    if (keyStatus === "bound" && !k.bound_ip) return false;
    if (keyStatus === "unbound" && k.bound_ip) return false;
    if (!keyNeedle) return true;
    return [
      k.owner_username,
      `uid:${k.owner_id}`,
      String(k.owner_id),
      String(k.user_key_number ?? k.id),
      k.bound_ip || "",
    ].some(v => (v || "").toLowerCase().includes(keyNeedle));
  });

  if (!allKeys.length) {
    const empty = document.createElement('div');
    empty.className = 'empty';
    const ico = document.createElement('div');
    ico.className = 'empty-icon';
    ico.textContent = '🔑';
    empty.append(ico, 'No API keys yet.');
    list.appendChild(empty);
    return;
  }

  if (!keys.length) {
    const empty = document.createElement('div');
    empty.className = 'empty';
    const ico = document.createElement('div');
    ico.className = 'empty-icon';
    ico.textContent = '⌕';
    empty.append(ico, 'No API keys match the filter.');
    list.appendChild(empty);
    return;
  }

  for (const k of keys) {
    const card = document.createElement('div');
    card.className = 'card';
    card.style.cssText = 'margin-bottom:8px;padding:0;overflow:hidden';

    const header = document.createElement('div');
    header.style.cssText = 'display:flex;align-items:center;gap:8px;padding:10px 14px;border-bottom:1px solid var(--border)';
    header.appendChild(selectionBox("keys", k.id, `Select API key #${k.user_key_number ?? k.id} for Danger Zone actions`));

    const idSpan = document.createElement('span');
    idSpan.style.cssText = 'font-family:var(--font-mono);font-weight:500';
    idSpan.textContent = `Key #${k.user_key_number ?? k.id}`;
    setTooltip(idSpan, "Per-user API key number.");

    const ownerSpan = document.createElement('span');
    ownerSpan.className = 'badge badge-gray';
    ownerSpan.textContent = k.owner_username || `uid:${k.owner_id}`;
    setTooltip(ownerSpan, "API key owner.");

    const ipSpan = document.createElement('span');
    ipSpan.className = 'text-xs text-muted';
    ipSpan.textContent = k.bound_ip ? `📍 ${k.bound_ip}` : 'unbound';
    setTooltip(ipSpan, k.bound_ip ? "This key is pinned to its first-use IP address." : "This key will bind to the next IP address that uses it.");

    const statusBadge = document.createElement('span');
    statusBadge.className = k.active ? 'badge badge-green' : 'badge badge-gray';
    statusBadge.style.marginLeft = '4px';
    statusBadge.textContent = k.active ? 'active' : 'inactive';
    setTooltip(statusBadge, k.active ? "This key can authenticate API requests." : "This key is revoked and cannot be used.");

    const spacer = document.createElement('div');
    spacer.style.flex = '1';

    header.append(idSpan, ownerSpan, ipSpan, statusBadge, spacer);

    if (k.active) {
      const resetBtn = document.createElement('button');
      resetBtn.className = 'btn btn-ghost btn-sm';
      resetBtn.textContent = 'Reset IP';
      setTooltip(resetBtn, "Clear this key's IP binding after password confirmation.");
      resetBtn.addEventListener('click', () => resetKeyIP(k.id));

      const revokeBtn = document.createElement('button');
      revokeBtn.className = 'btn btn-ghost btn-sm';
      revokeBtn.style.color = 'var(--danger)';
      revokeBtn.textContent = 'Revoke';
      setTooltip(revokeBtn, "Revoke this key so integrations using it stop immediately.");
      revokeBtn.addEventListener('click', () => deactivateKey(k.id));

      header.append(resetBtn, revokeBtn);
    }

    const footer = document.createElement('div');
    footer.style.cssText = 'padding:8px 14px;font-size:12px;color:var(--text-muted)';
    let footerText = `Created: ${new Date(k.created_at).toLocaleString()}`;
    if (k.last_used_at) footerText += ` · Last used: ${new Date(k.last_used_at).toLocaleString()}`;
    footer.textContent = footerText;

    card.append(header, footer);
    list.appendChild(card);
  }
}

async function createKey() {
  const resp = await apiFetch('/keys/', { method: 'POST', json: {} });
  if (!resp.ok) {
    const d = await resp.json().catch(() => ({}));
    showToast(d.detail || 'Failed to create key.', 'error');
    return;
  }
  const data = await resp.json();
  const modal = document.getElementById('new-key-modal');
  const rawKey = data.key;
  const body = document.getElementById('new-key-body');
  body.textContent = '';

  const warning = document.createElement('div');
  warning.className = 'text-sm mb-8';
  warning.style.color = 'var(--warning)';
  warning.textContent = '⚠ Copy this key now — it won’t be shown again.';

  const display = document.createElement('div');
  display.style.cssText = 'background:var(--surface-2);border:1px solid var(--border);border-radius:var(--radius);padding:10px 14px;font-family:var(--font-mono);font-size:13px;word-break:break-all;margin-bottom:8px';
  display.textContent = rawKey;

  const copyBtn = document.createElement('button');
  copyBtn.className = 'btn btn-ghost btn-sm';
  copyBtn.textContent = 'Copy key';
  copyBtn.addEventListener('click', () => {
    navigator.clipboard.writeText(rawKey).then(() => showToast('Copied!')).catch(() => {});
  });

  body.append(warning, display, copyBtn);
  modal.classList.remove('hidden');
  document.getElementById('new-key-close').onclick = () => {
    modal.classList.add('hidden');
    loadKeys();
  };
}

async function deactivateKey(id) {
  const ok = await showConfirm({
    title: "Revoke API key?",
    message: "Any integration using this key will immediately stop working. This cannot be undone.",
    confirmText: "Revoke key",
    danger: true,
  });
  if (!ok) return;
  const resp = await apiFetch(`/keys/${id}`, { method: 'DELETE' });
  if (resp.ok) { showToast('Key revoked.'); loadKeys(); }
  else { const d = await resp.json().catch(() => ({})); showToast(d.detail || 'Failed to revoke key.', 'error'); }
}

let _resetKeyId = null;
function resetKeyIP(id) {
  _resetKeyId = id;
  document.getElementById('reset-ip-pw').value = '';
  document.getElementById('reset-ip-modal').classList.remove('hidden');
  setTimeout(() => document.getElementById('reset-ip-pw').focus(), 50);
}

document.getElementById('reset-ip-cancel').addEventListener('click', () => {
  document.getElementById('reset-ip-modal').classList.add('hidden');
});
document.getElementById('reset-ip-confirm').addEventListener('click', async () => {
  const pw = document.getElementById('reset-ip-pw').value;
  if (!pw) return;
  const resp = await apiFetch(`/keys/${_resetKeyId}/reset-ip`, { method: 'POST', json: { password: pw } });
  document.getElementById('reset-ip-modal').classList.add('hidden');
  if (resp.ok) { showToast('IP binding cleared.'); loadKeys(); }
  else { const d = await resp.json().catch(() => ({})); showToast(d.detail || 'Failed to reset IP.', 'error'); }
});

document.getElementById('create-key-btn').addEventListener('click', createKey);
