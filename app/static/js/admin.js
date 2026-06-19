import { apiFetch, requireAuth, requireMaster, setupNav, formatBytes, formatDate, parseSize, parseDuration, showToast } from "./api.js";

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
    if (tab.dataset.tab === "files") loadAdminFiles();
    if (tab.dataset.tab === "keys") loadKeys();
  });
});

// ── Users ─────────────────────────────────────────────────────────────────
const usersTbody = document.getElementById("users-tbody");
let usersCache = [];

async function loadUsers() {
  usersTbody.textContent = "";
  const resp = await apiFetch("/users/");
  if (!resp.ok) { showToast("Failed to load users.", "error"); return; }
  const { users } = await resp.json();
  usersCache = users;

  for (const u of users) {
    const row = document.createElement("tr");

    const td1 = document.createElement("td");
    const nameEl = document.createElement("span");
    nameEl.style.fontWeight = "500";
    nameEl.textContent = u.username;
    td1.appendChild(nameEl);
    if (u.must_change_credentials) {
      const b = document.createElement("span");
      b.className = "badge badge-orange"; b.style.marginLeft = "8px"; b.textContent = "setup pending";
      td1.appendChild(b);
    }

    const td2 = document.createElement("td");
    const roleB = document.createElement("span");
    roleB.className = u.role === "master" ? "badge badge-orange" : "badge badge-gray";
    roleB.textContent = u.role;
    td2.appendChild(roleB);

    const td3 = document.createElement("td");
    const canUp = u.permissions?.can_upload ?? false;
    const upB = document.createElement("span");
    upB.className = canUp ? "badge badge-green" : "badge badge-gray";
    upB.textContent = canUp ? "yes" : "no";
    td3.appendChild(upB);

    const td4 = document.createElement("td");
    td4.className = "td-mono text-xs";
    td4.textContent = u.permissions ? formatBytes(u.permissions.quota_bytes) : "–";

    const td5 = document.createElement("td");
    td5.className = "text-xs text-muted";
    td5.textContent = "–";
    td5.dataset.userId = u.id;

    const td6 = document.createElement("td");
    td6.className = "text-xs text-muted";
    td6.textContent = formatDate(u.created_at);

    const td7 = document.createElement("td");
    const acts = document.createElement("div");
    acts.className = "td-actions";
    const permBtn = document.createElement("button");
    permBtn.className = "btn btn-ghost btn-sm";
    permBtn.textContent = "Permissions";
    permBtn.addEventListener("click", () => openPermModal(u));
    const delBtn = document.createElement("button");
    delBtn.className = "btn btn-danger btn-sm";
    delBtn.textContent = "Delete";
    delBtn.addEventListener("click", () => deleteUser(u.id, u.username));
    acts.append(permBtn, delBtn);
    td7.appendChild(acts);

    row.append(td1, td2, td3, td4, td5, td6, td7);
    usersTbody.appendChild(row);
  }
}

async function deleteUser(id, username) {
  if (!confirm(`Delete user "${username}"?\nTheir files will remain (orphaned).`)) return;
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
  document.getElementById("perm-can-delete").checked = !!p.can_delete;
  document.getElementById("perm-can-regen").checked  = !!p.can_regenerate_links;
  document.getElementById("perm-can-api").checked    = !!p.can_use_api_keys;
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
    can_upload:           document.getElementById("perm-can-upload").checked,
    can_delete:           document.getElementById("perm-can-delete").checked,
    can_regenerate_links: document.getElementById("perm-can-regen").checked,
    can_use_api_keys:     document.getElementById("perm-can-api").checked,
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

async function loadAdminFiles() {
  filesByUserEl.textContent = "";
  const [usersResp, filesResp] = await Promise.all([apiFetch("/users/"), apiFetch("/files/")]);
  if (!usersResp.ok || !filesResp.ok) { filesByUserEl.textContent = "Failed to load."; return; }
  const { users } = await usersResp.json();
  const { files } = await filesResp.json();

  // Update storage-used column in users table
  const byOwner = {};
  for (const f of files) {
    if (!byOwner[f.owner_id]) byOwner[f.owner_id] = { count: 0, bytes: 0, links: 0 };
    byOwner[f.owner_id].count++;
    byOwner[f.owner_id].bytes  += f.size_bytes;
    byOwner[f.owner_id].links  += f.links.length;
  }
  document.querySelectorAll("td[data-user-id]").forEach(td => {
    const stats = byOwner[parseInt(td.dataset.userId, 10)];
    td.textContent = stats ? formatBytes(stats.bytes) : "0 B";
  });

  const userMap = {};
  for (const u of users) userMap[u.id] = u;

  if (!files.length) {
    const empty = document.createElement("div");
    empty.className = "empty";
    const ico = document.createElement("div");
    ico.className = "empty-icon";
    ico.textContent = "📂";
    empty.append(ico, "No files yet.");
    filesByUserEl.appendChild(empty);
    return;
  }

  const sections = {};
  for (const f of files) {
    if (!sections[f.owner_id]) sections[f.owner_id] = [];
    sections[f.owner_id].push(f);
  }

  for (const [ownerId, ownerFiles] of Object.entries(sections)) {
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
    const sizeBadge = document.createElement("span");
    sizeBadge.className = "text-xs text-muted";
    sizeBadge.textContent = formatBytes(ownerFiles.reduce((a, f) => a + f.size_bytes, 0));
    header.append(nameEl, countBadge, sizeBadge);
    section.appendChild(header);

    const card = document.createElement("div");
    card.className = "card";
    card.style.padding = "0";

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

      const activeLinks = f.links.filter(l => l.active).length;
      const linksBadge = document.createElement("span");
      linksBadge.className = activeLinks > 0 ? "badge badge-green" : "badge badge-gray";
      linksBadge.textContent = `${activeLinks}/${f.links.length} links`;

      const expandBtn = document.createElement("button");
      expandBtn.className = "file-expand-btn";
      expandBtn.textContent = "▶ Links";

      const delBtn = document.createElement("button");
      delBtn.className = "btn btn-danger btn-sm";
      delBtn.textContent = "Delete";
      delBtn.addEventListener("click", e => { e.stopPropagation(); deleteAdminFile(f.id, f.original_filename); });

      row.append(nameDiv, sizeDiv, dateDiv, typeDiv, linksBadge, expandBtn, delBtn);

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
        if (e.target === delBtn) return;
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
  mintBtn.addEventListener("click", async () => {
    const resp = await apiFetch(`/files/${f.id}/links`, { method: "POST", json: {} });
    if (!resp.ok) { showToast("Failed to create link.", "error"); return; }
    const data = await resp.json();
    showToast("Link created!");
    navigator.clipboard.writeText(data.url).catch(() => {});
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

    const url = `${location.origin}/file/${lk.slug}`;
    const slugSpan = document.createElement("span");
    slugSpan.className = "file-link-slug";
    slugSpan.textContent = url;
    slugSpan.title = url;

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
      lrow.append(dot, slugSpan, uses, exp, badge);
    } else {
      const copyBtn = document.createElement("button");
      copyBtn.className = "btn btn-ghost btn-sm";
      copyBtn.textContent = "Copy";
      copyBtn.addEventListener("click", () => {
        navigator.clipboard.writeText(url).then(() => {
          copyBtn.textContent = "Copied!";
          setTimeout(() => (copyBtn.textContent = "Copy"), 1500);
        });
      });

      const editBtn = document.createElement("button");
      editBtn.className = "btn btn-ghost btn-sm";
      editBtn.textContent = "Edit";
      editBtn.addEventListener("click", () => openLinkEditModal(lk));

      const deactBtn = document.createElement("button");
      deactBtn.className = "btn btn-ghost btn-sm";
      deactBtn.textContent = "Deactivate";
      deactBtn.addEventListener("click", async () => {
        const resp = await apiFetch(`/links/${lk.id}`, { method: "DELETE" });
        if (resp.ok) { showToast("Link deactivated."); loadAdminFiles(); }
        else showToast("Failed.", "error");
      });

      lrow.append(dot, slugSpan, uses, exp, copyBtn, editBtn, deactBtn);
    }

    container.appendChild(lrow);
  }
}

async function deleteAdminFile(id, name) {
  if (!confirm(`Delete "${name}"?\nThis cannot be undone.`)) return;
  const resp = await apiFetch(`/files/${id}`, { method: "DELETE" });
  if (resp.ok) { showToast("File deleted."); loadAdminFiles(); loadDiskStats(); }
  else { const d = await resp.json().catch(() => ({})); showToast(d.detail || "Delete failed.", "error"); }
}

// ── Audit log ─────────────────────────────────────────────────────────────
const auditTbody = document.getElementById("audit-tbody");
const LIMIT = 50;
let auditOffset = 0;

async function loadAudit() {
  auditTbody.textContent = "";
  const loadRow = document.createElement("tr");
  const loadTd  = document.createElement("td");
  loadTd.colSpan = 6; loadTd.className = "empty"; loadTd.textContent = "Loading…";
  loadRow.appendChild(loadTd);
  auditTbody.appendChild(loadRow);

  const resp = await apiFetch(`/audit/?limit=${LIMIT}&offset=${auditOffset}`);
  if (!resp.ok) { showToast("Failed to load audit log.", "error"); return; }
  const { entries, chain_ok } = await resp.json();

  const badge = document.getElementById("chain-badge");
  badge.className = chain_ok ? "badge badge-green" : "badge badge-red";
  badge.textContent = chain_ok ? "chain ok" : "chain BROKEN";
  badge.classList.remove("hidden");

  auditTbody.textContent = "";
  if (!entries.length) {
    const r = document.createElement("tr");
    const td = document.createElement("td");
    td.colSpan = 6; td.className = "empty"; td.textContent = "No entries.";
    r.appendChild(td);
    auditTbody.appendChild(r);
    return;
  }

  for (const e of entries) {
    const row = document.createElement("tr");
    [String(e.id), e.actor, e.action, e.target || "–", e.ip || "–", formatDate(e.created_at)].forEach((v, i) => {
      const td = document.createElement("td");
      td.className = [
        "td-mono", "td-mono", "", "text-xs text-muted", "td-mono text-xs", "text-xs text-muted"
      ][i] || "";
      td.textContent = v;
      row.appendChild(td);
    });
    auditTbody.appendChild(row);
  }

  document.getElementById("audit-page").textContent = `${auditOffset + 1}–${auditOffset + entries.length}`;
  document.getElementById("audit-prev").disabled = auditOffset === 0;
  document.getElementById("audit-next").disabled = entries.length < LIMIT;
}

document.getElementById("audit-prev").addEventListener("click", () => { auditOffset = Math.max(0, auditOffset - LIMIT); loadAudit(); });
document.getElementById("audit-next").addEventListener("click", () => { auditOffset += LIMIT; loadAudit(); });

loadDiskStats();
loadUsers();


// ── API Keys tab ────────────────────────────────────────────────────────────

async function loadKeys() {
  const resp = await apiFetch('/keys/');
  if (!resp.ok) { showToast('Failed to load API keys.', 'error'); return; }
  const data = await resp.json();
  const list = document.getElementById('keys-list');
  if (!data.keys.length) {
    list.innerHTML = '<div class="empty"><div class="empty-icon">🔑</div>No API keys yet.</div>';
    return;
  }
  list.innerHTML = data.keys.map(k => `
    <div class="card" style="margin-bottom:8px;padding:0;overflow:hidden">
      <div style="display:flex;align-items:center;gap:8px;padding:10px 14px;border-bottom:1px solid var(--border)">
        <span style="font-family:var(--font-mono);font-weight:500">Key #${k.id}</span>
        <span class="text-xs text-muted">${k.bound_ip ? '📍 ' + k.bound_ip : 'unbound'}</span>
        <span class="${k.active ? 'badge badge-green' : 'badge badge-gray'}" style="margin-left:4px">${k.active ? 'active' : 'inactive'}</span>
        <div style="flex:1"></div>
        ${k.active ? `
          <button class="btn btn-ghost btn-sm" onclick="resetKeyIP(${k.id})">Reset IP</button>
          <button class="btn btn-ghost btn-sm" style="color:var(--danger)" onclick="deactivateKey(${k.id})">Revoke</button>
        ` : ''}
      </div>
      <div style="padding:8px 14px;font-size:12px;color:var(--text-muted)">
        Created: ${new Date(k.created_at).toLocaleString()}
        ${k.last_used_at ? ' · Last used: ' + new Date(k.last_used_at).toLocaleString() : ''}
      </div>
    </div>
  `).join('');
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
  document.getElementById('new-key-body').innerHTML = `
    <div class="text-sm mb-8" style="color:var(--warning)">⚠ Copy this key now — it won't be shown again.</div>
    <div style="background:var(--surface-2);border:1px solid var(--border);border-radius:var(--radius);padding:10px 14px;font-family:var(--font-mono);font-size:13px;word-break:break-all;margin-bottom:8px" id="new-key-display"></div>
    <button class="btn btn-ghost btn-sm" id="copy-key-btn">Copy key</button>
  `;
  document.getElementById('new-key-display').textContent = rawKey;
  document.getElementById('copy-key-btn').addEventListener('click', () => {
    navigator.clipboard.writeText(rawKey).then(() => showToast('Copied!'));
  });
  modal.classList.remove('hidden');
  document.getElementById('new-key-close').onclick = () => {
    modal.classList.add('hidden');
    loadKeys();
  };
}

async function deactivateKey(id) {
  if (!confirm('Revoke this key? This cannot be undone.')) return;
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
