'use strict';

/* ── State ─────────────────────────────────────────────────── */
let adminKey    = sessionStorage.getItem('adminKey') || '';
let allItems    = [];
let allTags     = [];
let modalHash   = null;
let modalTags   = [];
let confirmCb   = null;

/* ── DOM ────────────────────────────────────────────────────── */
const loginScreen   = document.getElementById('loginScreen');
const adminPanel    = document.getElementById('adminPanel');
const loginError    = document.getElementById('loginError');
const adminKeyInput = document.getElementById('adminKeyInput');
const libSearch     = document.getElementById('libSearch');
const libTypeFilter = document.getElementById('libTypeFilter');
const libVerdictFilter = document.getElementById('libVerdictFilter');
const modalOverlay  = document.getElementById('modalOverlay');
const confirmOverlay= document.getElementById('confirmOverlay');

/* ── Login ──────────────────────────────────────────────────── */
document.getElementById('loginBtn').addEventListener('click', tryLogin);
adminKeyInput.addEventListener('keydown', e => { if (e.key === 'Enter') tryLogin(); });

async function tryLogin() {
  const key = adminKeyInput.value.trim();
  if (!key) return;
  // Quick verify: hit a protected endpoint
  try {
    const res = await fetch('/api/admin/library', {
      headers: { 'x-admin-key': key }
    });
    if (res.status === 401) {
      loginError.classList.remove('hidden');
      return;
    }
    adminKey = key;
    sessionStorage.setItem('adminKey', adminKey);
    loginError.classList.add('hidden');
    showAdmin(await res.json());
  } catch {
    loginError.classList.remove('hidden');
  }
}

async function autoLogin() {
  if (!adminKey) return;
  try {
    const res = await fetch('/api/admin/library', {
      headers: { 'x-admin-key': adminKey }
    });
    if (res.status === 401) { adminKey = ''; sessionStorage.removeItem('adminKey'); return; }
    showAdmin(await res.json());
  } catch { /* no-op */ }
}

function showAdmin(items) {
  loginScreen.classList.add('hidden');
  adminPanel.classList.remove('hidden');
  allItems = items;
  applyLibFilter();
  updateStats();
  loadTags();
}

document.getElementById('logoutBtn').addEventListener('click', () => {
  adminKey = ''; sessionStorage.removeItem('adminKey');
  location.reload();
});

/* ── Nav tabs ───────────────────────────────────────────────── */
document.querySelectorAll('.nav-item').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.nav-item').forEach(b => b.classList.remove('active'));
    document.querySelectorAll('.admin-view').forEach(v => v.classList.remove('active'));
    btn.classList.add('active');
    document.getElementById('view' + cap(btn.dataset.view)).classList.add('active');
  });
});

function cap(s) { return s.charAt(0).toUpperCase() + s.slice(1); }

/* ── Stats ──────────────────────────────────────────────────── */
function updateStats() {
  const n        = allItems.length;
  const images   = allItems.filter(i => i.type === 'image').length;
  const videos   = allItems.filter(i => i.type === 'video').length;
  const ai       = allItems.filter(i => i.is_ai).length;
  const overlays = allItems.filter(i => i.overlay_ready).length;
  document.getElementById('libCount').textContent  = n;
  document.getElementById('statTotal').textContent    = n;
  document.getElementById('statImages').textContent   = images;
  document.getElementById('statVideos').textContent   = videos;
  document.getElementById('statAi').textContent       = ai;
  document.getElementById('statOverlays').textContent = overlays;
}

/* ── Library filter & render ────────────────────────────────── */
libSearch.addEventListener('input', applyLibFilter);
libTypeFilter.addEventListener('change', applyLibFilter);
libVerdictFilter.addEventListener('change', applyLibFilter);

function applyLibFilter() {
  const q       = libSearch.value.trim().toLowerCase();
  const type    = libTypeFilter.value;
  const verdict = libVerdictFilter.value;

  let filtered = allItems;
  if (type !== 'all')    filtered = filtered.filter(i => i.type === type);
  if (verdict === 'ai')  filtered = filtered.filter(i => i.is_ai);
  if (verdict === 'real')filtered = filtered.filter(i => !i.is_ai);
  if (q) {
    filtered = filtered.filter(i =>
      i.filename.toLowerCase().includes(q) ||
      (i.tags || []).some(t => t.includes(q))
    );
  }
  renderLibGrid(filtered);
}

function renderLibGrid(items) {
  const grid  = document.getElementById('adminLibGrid');
  const empty = document.getElementById('adminLibEmpty');
  grid.innerHTML = '';

  if (!items.length) { empty.classList.remove('hidden'); return; }
  empty.classList.add('hidden');

  items.forEach(item => {
    const card  = document.createElement('div');
    const isAi  = item.is_ai;
    const isVid = item.type === 'video';
    const aiPct = Math.round((item.ai_probability || 0) * 100);
    card.className    = `admin-card ${isAi ? 'verdict-ai' : 'verdict-real'}`;
    card.dataset.hash = item.file_hash;

    const thumbHtml = item.thumbnail_url
      ? `<img src="${item.thumbnail_url}" alt="" loading="lazy">`
      : `<div class="admin-card-no-thumb">${isVid ? '🎞️' : '🖼️'}</div>`;

    const tagsHtml = (item.tags || []).slice(0, 4)
      .map(t => `<span class="admin-card-tag">#${esc(t)}</span>`).join('');

    const durText = isVid && item.duration_seconds ? fmtDur(item.duration_seconds) + ' · ' : '';

    card.innerHTML = `
      <div class="admin-card-thumb">
        ${thumbHtml}
        <span class="admin-card-verdict ${isAi ? 'ai' : 'real'}">${isAi ? '🤖 AI' : '✅ Real'}</span>
        <span class="admin-card-score ${isAi ? 'ai' : 'real'}">${aiPct}%</span>
      </div>
      <div class="admin-card-body">
        <div class="admin-card-name" title="${esc(item.filename)}">${esc(item.filename)}</div>
        <div class="admin-card-meta">${durText}${relTime(item.analyzed_at)}</div>
        ${tagsHtml ? `<div class="admin-card-tags">${tagsHtml}</div>` : ''}
        <div class="admin-card-actions">
          <button class="btn-admin-detail" data-hash="${item.file_hash}">Details</button>
          <button class="btn-admin-delete" data-hash="${item.file_hash}">🗑</button>
        </div>
      </div>`;

    card.querySelector('.btn-admin-detail').addEventListener('click', e => {
      e.stopPropagation();
      openItemModal(item.file_hash);
    });
    card.querySelector('.btn-admin-delete').addEventListener('click', e => {
      e.stopPropagation();
      confirmDelete(item.file_hash, item.filename);
    });

    grid.appendChild(card);
  });
}

/* ── Item detail modal ──────────────────────────────────────── */
async function openItemModal(hash) {
  modalHash = hash;
  const item = allItems.find(i => i.file_hash === hash);
  if (!item) return;

  // Fetch full result for complete tags list
  const res  = await fetch(`/api/result/${hash}`);
  const data = res.ok ? await res.json() : item;
  modalTags  = [...(data.tags || [])];

  const isAi  = data.is_ai;
  const aiPct = Math.round((data.ai_probability || 0) * 100);

  document.getElementById('modalTitle').textContent = data.filename || hash;

  // Media preview: overlay video > thumbnail image > nothing
  const isVideo = data.type === 'video';
  let mediaHtml = '';
  if (isVideo && data.overlay_ready) {
    mediaHtml = `
      <div class="modal-video-wrap">
        <video class="modal-video" src="/api/overlay/${hash}" controls playsinline preload="metadata"></video>
        <span class="modal-video-label">AI Meter Overlay</span>
      </div>`;
  } else if (data.thumbnail_url) {
    mediaHtml = `<img src="${data.thumbnail_url}" class="modal-thumb" alt="">`;
  }

  document.getElementById('modalBody').innerHTML = `
    ${mediaHtml}
    <div class="modal-meta-grid">
      <div class="modal-meta-item">
        <div class="modal-meta-key">Verdict</div>
        <div class="modal-meta-val" style="color:${isAi ? '#c084fc' : '#4ade80'}">${data.verdict || '—'}</div>
      </div>
      <div class="modal-meta-item">
        <div class="modal-meta-key">AI probability</div>
        <div class="modal-meta-val">${aiPct}%</div>
      </div>
      <div class="modal-meta-item">
        <div class="modal-meta-key">Type</div>
        <div class="modal-meta-val">${data.type || '—'}</div>
      </div>
      <div class="modal-meta-item">
        <div class="modal-meta-key">Analyzed</div>
        <div class="modal-meta-val">${relTime(data.analyzed_at)}</div>
      </div>
      ${data.duration_seconds ? `
      <div class="modal-meta-item">
        <div class="modal-meta-key">Duration</div>
        <div class="modal-meta-val">${fmtDur(data.duration_seconds)}</div>
      </div>` : ''}
      <div class="modal-meta-item">
        <div class="modal-meta-key">Hash</div>
        <div class="modal-meta-val" style="font-family:monospace;font-size:0.7rem">${hash.slice(0,16)}…</div>
      </div>
    </div>

    <div class="modal-tags-edit">
      <h4>Tags</h4>
      <div class="modal-tags-chips" id="modalTagChips"></div>
      <div class="modal-tag-add-row">
        <input class="modal-tag-input" id="modalTagInput" placeholder="Add tag…" maxlength="40">
        <button class="btn-modal-add-tag" id="modalAddTagBtn">Add</button>
      </div>
      <button class="btn-modal-save-tags" id="modalSaveTagsBtn">Save Tags</button>
    </div>

    <div class="modal-delete-zone">
      <button class="btn-modal-delete" id="modalDeleteBtn">🗑 Delete this item permanently</button>
    </div>`;

  renderModalTags();

  document.getElementById('modalAddTagBtn').addEventListener('click', modalAddTag);
  document.getElementById('modalTagInput').addEventListener('keydown', e => {
    if (e.key === 'Enter') modalAddTag();
  });
  document.getElementById('modalSaveTagsBtn').addEventListener('click', modalSaveTags);
  document.getElementById('modalDeleteBtn').addEventListener('click', () => {
    closeModal();
    confirmDelete(hash, data.filename);
  });

  modalOverlay.classList.remove('hidden');
}

function renderModalTags() {
  const chips = document.getElementById('modalTagChips');
  if (!chips) return;
  chips.innerHTML = '';
  modalTags.forEach(tag => {
    const chip = document.createElement('span');
    chip.className = 'modal-tag-chip';
    chip.innerHTML = `#${esc(tag)} <button class="modal-tag-remove" data-tag="${esc(tag)}" title="Remove">×</button>`;
    chip.querySelector('.modal-tag-remove').addEventListener('click', () => {
      modalTags = modalTags.filter(t => t !== tag);
      renderModalTags();
    });
    chips.appendChild(chip);
  });
}

function modalAddTag() {
  const input = document.getElementById('modalTagInput');
  const raw   = input.value.trim().toLowerCase().replace(/[^a-z0-9\-_]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g,'');
  if (!raw || modalTags.includes(raw)) { input.value = ''; return; }
  modalTags.push(raw);
  input.value = '';
  renderModalTags();
}

async function modalSaveTags() {
  const btn = document.getElementById('modalSaveTagsBtn');
  btn.disabled = true; btn.textContent = 'Saving…';
  try {
    const res = await fetch(`/api/admin/tags/${modalHash}`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json', 'x-admin-key': adminKey },
      body:    JSON.stringify({ tags: modalTags }),
    });
    if (!res.ok) throw new Error();
    const data = await res.json();
    // Update local cache
    const item = allItems.find(i => i.file_hash === modalHash);
    if (item) item.tags = data.tags;
    btn.textContent = '✓ Saved';
    setTimeout(() => { if (btn) btn.textContent = 'Save Tags'; btn.disabled = false; }, 2000);
    applyLibFilter();
    loadTags();
  } catch {
    btn.disabled = false; btn.textContent = 'Save Tags';
    alert('Failed to save tags.');
  }
}

document.getElementById('modalClose').addEventListener('click', closeModal);
modalOverlay.addEventListener('click', e => { if (e.target === modalOverlay) closeModal(); });
function closeModal() { modalOverlay.classList.add('hidden'); modalHash = null; }

/* ── Delete ─────────────────────────────────────────────────── */
function confirmDelete(hash, filename) {
  document.getElementById('confirmMsg').textContent =
    `Delete "${filename}"? This removes the item, tags, thumbnail and overlay. Cannot be undone.`;
  confirmCb = () => deleteItem(hash);
  confirmOverlay.classList.remove('hidden');
}

document.getElementById('confirmCancel').addEventListener('click', () => {
  confirmOverlay.classList.add('hidden'); confirmCb = null;
});
document.getElementById('confirmOk').addEventListener('click', () => {
  confirmOverlay.classList.add('hidden');
  if (confirmCb) { confirmCb(); confirmCb = null; }
});

async function deleteItem(hash) {
  try {
    const res = await fetch(`/api/admin/item/${hash}`, {
      method: 'DELETE',
      headers: { 'x-admin-key': adminKey },
    });
    if (!res.ok) throw new Error();
    allItems = allItems.filter(i => i.file_hash !== hash);
    applyLibFilter();
    updateStats();
    loadTags();
  } catch {
    alert('Delete failed.');
  }
}

/* ── Tags view ──────────────────────────────────────────────── */
async function loadTags() {
  try {
    const res = await fetch('/api/admin/tags', { headers: { 'x-admin-key': adminKey } });
    if (!res.ok) return;
    allTags = await res.json();
    renderTagsView();
    document.getElementById('tagCount').textContent = allTags.length;
  } catch { /* ignore */ }
}

function renderTagsView() {
  const list  = document.getElementById('adminTagsList');
  const empty = document.getElementById('adminTagsEmpty');
  list.innerHTML = '';
  if (!allTags.length) { empty.classList.remove('hidden'); return; }
  empty.classList.add('hidden');

  allTags.forEach(({ tag, count }) => {
    const pill = document.createElement('div');
    pill.className = 'admin-tag-pill';
    pill.innerHTML = `
      <span class="admin-tag-name">#${esc(tag)}</span>
      <span class="admin-tag-count">${count}</span>
      <button class="admin-tag-del" title="Delete tag from all items" data-tag="${esc(tag)}">×</button>`;
    pill.querySelector('.admin-tag-del').addEventListener('click', () => confirmDeleteTag(tag));
    list.appendChild(pill);
  });
}

function confirmDeleteTag(tag) {
  document.getElementById('confirmMsg').textContent =
    `Remove tag "#${tag}" from all items? This cannot be undone.`;
  confirmCb = () => deleteTagGlobally(tag);
  confirmOverlay.classList.remove('hidden');
}

async function deleteTagGlobally(tag) {
  // Delete the tag from every item that has it
  const affected = allItems.filter(i => (i.tags || []).includes(tag));
  try {
    for (const item of affected) {
      await fetch(`/api/admin/tag/${item.file_hash}/${encodeURIComponent(tag)}`, {
        method: 'DELETE',
        headers: { 'x-admin-key': adminKey },
      });
      item.tags = (item.tags || []).filter(t => t !== tag);
    }
    applyLibFilter();
    loadTags();
  } catch {
    alert('Failed to delete tag.');
  }
}

/* ── Helpers ────────────────────────────────────────────────── */
function esc(s) {
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}
function relTime(iso) {
  const d    = new Date(iso.endsWith('Z') ? iso : iso + 'Z');
  const secs = (Date.now() - d) / 1000;
  if (secs < 60)     return 'just now';
  if (secs < 3600)   return `${Math.floor(secs/60)}m ago`;
  if (secs < 86400)  return `${Math.floor(secs/3600)}h ago`;
  if (secs < 604800) return `${Math.floor(secs/86400)}d ago`;
  return d.toLocaleDateString();
}
function fmtDur(s) {
  const m = Math.floor(s/60), sec = Math.round(s%60);
  return m ? `${m}m ${sec}s` : `${sec}s`;
}

/* ── Boot ───────────────────────────────────────────────────── */
autoLogin();
