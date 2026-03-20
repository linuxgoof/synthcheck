'use strict';

/* ── State ──────────────────────────────────────────────── */
let currentFile      = null;
let currentHash      = null;
let pendingTags      = [];   // suggested but not yet accepted
let acceptedTags     = [];   // accepted/saved tags (dirty until saved)
let tagsDirty        = false;
let libraryItems     = [];   // full library cache
let libActiveType    = 'all';
let libActiveTag     = null;

/* ── DOM refs ───────────────────────────────────────────── */
const dropZone          = document.getElementById('dropZone');
const fileInput         = document.getElementById('fileInput');
const uploadSection     = document.getElementById('uploadSection');
const previewSection    = document.getElementById('previewSection');
const previewMediaWrap  = document.getElementById('previewMediaWrap');
const previewFilename   = document.getElementById('previewFilename');
const previewFilesize   = document.getElementById('previewFilesize');
const clearBtn          = document.getElementById('clearBtn');
const analyzeBtn        = document.getElementById('analyzeBtn');
const loadingSection    = document.getElementById('loadingSection');
const resultsSection    = document.getElementById('resultsSection');
const errorSection      = document.getElementById('errorSection');
const statusText        = document.getElementById('statusText');
const badgeDot          = document.querySelector('.badge-dot');
const exportVideoBtn    = document.getElementById('exportVideoBtn');
const libraryBtn        = document.getElementById('libraryBtn');
const librarySection    = document.getElementById('librarySection');
const libraryBackBtn    = document.getElementById('libraryBackBtn');
const cacheBanner       = document.getElementById('cacheBanner');
const cacheBannerDate   = document.getElementById('cacheBannerDate');
const libraryCountBadge = document.getElementById('libraryCountBadge');
// Tags
const tagsSection       = document.getElementById('tagsSection');
const tagsSuggested     = document.getElementById('tagsSuggested');
const tagsSaved         = document.getElementById('tagsSaved');
const tagsHint          = document.getElementById('tagsHint');
const tagInput          = document.getElementById('tagInput');
const addTagBtn         = document.getElementById('addTagBtn');
const saveTagsBtn       = document.getElementById('saveTagsBtn');
// Library filters
const libTagFilter      = document.getElementById('libTagFilter');
const libTagChips       = document.getElementById('libTagChips');
const libTagClearBtn    = document.getElementById('libTagClearBtn');

/* ── Health check ───────────────────────────────────────── */
async function checkHealth() {
  try {
    const res  = await fetch('/api/health');
    const data = await res.json();
    if (data.models_loaded) {
      statusText.textContent = 'Models ready';
      badgeDot.classList.add('ready');
    } else {
      statusText.textContent = 'Loading models…';
      setTimeout(checkHealth, 3000);
    }
  } catch {
    setTimeout(checkHealth, 5000);
  }
}
checkHealth();
refreshLibraryCount();

/* ── Drag & drop ────────────────────────────────────────── */
['dragenter','dragover'].forEach(evt =>
  dropZone.addEventListener(evt, e => { e.preventDefault(); dropZone.classList.add('drag-over'); })
);
['dragleave','drop'].forEach(evt =>
  dropZone.addEventListener(evt, e => { e.preventDefault(); dropZone.classList.remove('drag-over'); })
);
dropZone.addEventListener('drop', e => { const f = e.dataTransfer.files[0]; if (f) setFile(f); });
dropZone.addEventListener('click', e => {
  if (e.target !== document.querySelector('.browse-link')) fileInput.click();
});
fileInput.addEventListener('change', () => { if (fileInput.files[0]) setFile(fileInput.files[0]); });

/* ── File handling ──────────────────────────────────────── */
function setFile(file) {
  currentFile = file;
  previewMediaWrap.innerHTML = '';
  if (file.type.startsWith('image/')) {
    const img = document.createElement('img');
    img.src = URL.createObjectURL(file);
    previewMediaWrap.appendChild(img);
  } else if (file.type.startsWith('video/')) {
    const vid = document.createElement('video');
    vid.src = URL.createObjectURL(file);
    vid.muted = true; vid.playsInline = true;
    previewMediaWrap.appendChild(vid);
  } else {
    previewMediaWrap.innerHTML = `<svg width="32" height="32" viewBox="0 0 32 32" fill="none"><rect x="4" y="2" width="24" height="28" rx="3" stroke="#6366f1" stroke-width="1.5"/><path d="M10 10h12M10 16h12M10 22h6" stroke="#6366f1" stroke-width="1.5" stroke-linecap="round"/></svg>`;
  }
  previewFilename.textContent = file.name;
  previewFilesize.textContent = formatBytes(file.size);
  show(previewSection); hide(uploadSection); hide(resultsSection); hide(errorSection);
}

function clearFile() {
  currentFile = null; currentHash = null;
  fileInput.value = '';
  hide(cacheBanner); resetExportBtn(); resetTags();
  show(uploadSection); hide(previewSection); hide(resultsSection); hide(errorSection);
}

clearBtn.addEventListener('click', clearFile);
document.getElementById('resetBtn').addEventListener('click', clearFile);
document.getElementById('errorResetBtn').addEventListener('click', clearFile);

/* ── Analysis ───────────────────────────────────────────── */
analyzeBtn.addEventListener('click', runAnalysis);

async function runAnalysis() {
  if (!currentFile) return;
  hide(previewSection); hide(resultsSection); hide(errorSection);
  show(loadingSection);

  const stepDuration = [600, 1200, 1800, 400];
  const steps = ['step1','step2','step3','step4'];
  let stepTimers = [];
  steps.forEach((id, i) => {
    const el = document.getElementById(id);
    el.className = 'step';
    if (i === 0) el.classList.add('active');
    const d = stepDuration.slice(0, i).reduce((a, b) => a + b, 0);
    stepTimers.push(setTimeout(() => {
      steps.forEach((sid, j) => {
        const s = document.getElementById(sid);
        if (j < i) s.className = 'step done';
        else if (j === i) s.className = 'step active';
        else s.className = 'step';
      });
    }, d));
  });

  const formData = new FormData();
  formData.append('file', currentFile);
  try {
    const res = await fetch('/api/analyze', { method: 'POST', body: formData });
    stepTimers.forEach(clearTimeout);
    steps.forEach(id => document.getElementById(id).className = 'step done');
    await delay(300);
    hide(loadingSection);
    if (!res.ok) {
      const err = await res.json().catch(() => ({ detail: `HTTP ${res.status}` }));
      showError(err.detail || 'Analysis failed.');
      return;
    }
    const data = await res.json();
    currentHash = data.file_hash || null;
    renderResults(data);
    refreshLibraryCount();
  } catch {
    stepTimers.forEach(clearTimeout);
    hide(loadingSection);
    showError('Network error — is the server running?');
  }
}

/* ── Render results ─────────────────────────────────────── */
function renderResults(data) {
  const isAi    = data.is_ai;
  const aiPct   = Math.round(data.ai_probability * 100);
  const realPct = Math.round(data.real_probability * 100);
  const confPct = Math.round(data.confidence * 100);

  document.getElementById('resultCard').className = 'result-card ' + (isAi ? 'verdict-ai' : 'verdict-real');

  const verdictIcon  = document.getElementById('verdictIcon');
  const verdictLabel = document.getElementById('verdictLabel');
  const verdictSub   = document.getElementById('verdictSub');
  const confValue    = document.getElementById('confidenceValue');

  if (isAi) {
    verdictIcon.innerHTML  = '🤖';
    verdictIcon.className  = 'verdict-icon ai';
    verdictLabel.textContent = 'AI Generated';
    verdictLabel.className = 'verdict-label ai';
    verdictSub.textContent = 'Signs of artificial generation detected';
    confValue.style.color  = 'var(--ai-color)';
  } else {
    verdictIcon.innerHTML  = '✅';
    verdictIcon.className  = 'verdict-icon real';
    verdictLabel.textContent = 'Real / Authentic';
    verdictLabel.className = 'verdict-label real';
    verdictSub.textContent = 'No significant signs of AI generation';
    confValue.style.color  = 'var(--real-color)';
  }
  confValue.textContent = confPct + '%';

  document.getElementById('aiPct').textContent   = aiPct + '%';
  document.getElementById('realPct').textContent  = realPct + '%';
  requestAnimationFrame(() => requestAnimationFrame(() => {
    document.getElementById('aiBar').style.width   = aiPct + '%';
    document.getElementById('realBar').style.width = realPct + '%';
  }));

  // Cache banner
  if (data.cached) {
    cacheBannerDate.textContent = relativeTime(data.analyzed_at);
    cacheBanner.classList.remove('hidden');
  } else {
    cacheBanner.classList.add('hidden');
  }

  // Export button
  if (data.type === 'video') {
    exportVideoBtn.classList.remove('hidden');
    if (data.overlay_ready && data.file_hash) {
      exportVideoBtn.innerHTML = `<svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M8 2v7M5 6l3 3 3-3" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/><path d="M2 11v1a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2v-1" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg> Download Overlay`;
      exportVideoBtn.dataset.mode = 'download';
      exportVideoBtn.dataset.hash = data.file_hash;
      exportVideoBtn.disabled = false;
    } else if (!currentFile) {
      exportVideoBtn.classList.add('hidden');
    } else {
      exportVideoBtn.dataset.mode = 'export';
      exportVideoBtn.disabled = false;
    }
  } else {
    exportVideoBtn.classList.add('hidden');
  }

  // Video extras
  const videoExtras = document.getElementById('videoExtras');
  if (data.type === 'video') {
    videoExtras.classList.remove('hidden');
    document.getElementById('metaDuration').textContent    = formatDuration(data.duration_seconds);
    document.getElementById('metaFps').textContent         = data.fps + ' fps';
    document.getElementById('metaFrames').textContent      = `${data.frames_analyzed} / ${data.total_frames.toLocaleString()}`;
    const c = data.temporal_consistency;
    document.getElementById('metaConsistency').textContent = `${c > 0.85 ? 'High' : c > 0.65 ? 'Medium' : 'Low'} (${Math.round(c * 100)}%)`;
    document.getElementById('axisEnd').textContent         = formatDuration(data.duration_seconds);
    renderFrameTimeline(data.frame_results, data.duration_seconds);
  } else {
    videoExtras.classList.add('hidden');
  }

  // Tags
  renderTagsSection(data.suggested_tags || [], data.tags || [], !!data.cached);

  show(resultsSection);
}

function renderFrameTimeline(frames, duration) {
  const timeline = document.getElementById('frameTimeline');
  timeline.innerHTML = '';
  if (!frames || !frames.length) return;
  const maxPct = Math.max(...frames.map(f => Math.max(f.ai_probability, f.real_probability)));
  frames.forEach(f => {
    const bar = document.createElement('div');
    bar.className = 'frame-bar ' + (f.is_ai ? 'ai' : 'real');
    bar.style.height = Math.max(15, Math.round((Math.max(f.ai_probability, f.real_probability) / maxPct) * 100)) + '%';
    bar.setAttribute('data-tooltip', `${f.verdict} @ ${f.timestamp}s — AI: ${Math.round(f.ai_probability * 100)}%`);
    timeline.appendChild(bar);
  });
}

/* ── Tags UI ─────────────────────────────────────────────── */
function resetTags() {
  pendingTags  = [];
  acceptedTags = [];
  tagsDirty    = false;
  tagsSuggested.innerHTML = '';
  tagsSaved.innerHTML     = '';
  tagsSuggested.classList.add('hidden');
  saveTagsBtn.classList.add('hidden');
  tagsHint.textContent = 'AI-suggested · click to accept';
}

function renderTagsSection(suggested, saved, isCached) {
  resetTags();
  acceptedTags = [...saved];

  if (isCached || !suggested.length) {
    // Already saved or no suggestions — just show saved tags in edit mode
    tagsHint.textContent = saved.length ? 'Click × to remove · add more below' : 'No tags yet — add some below';
  } else {
    // Fresh analysis — show suggestions
    pendingTags = suggested.filter(t => !saved.includes(t));
    if (pendingTags.length) {
      tagsSuggested.classList.remove('hidden');
      tagsHint.textContent = 'AI-suggested · click to accept';
    }
    renderSuggestedChips();
  }
  renderSavedChips();
}

function renderSuggestedChips() {
  tagsSuggested.innerHTML = '';
  pendingTags.forEach(tag => {
    const chip = document.createElement('button');
    chip.className   = 'tag-chip tag-chip-pending';
    chip.textContent = '#' + tag;
    chip.title       = 'Click to accept';
    chip.addEventListener('click', () => acceptTag(tag));
    tagsSuggested.appendChild(chip);
  });
  if (!pendingTags.length) tagsSuggested.classList.add('hidden');
}

function renderSavedChips() {
  tagsSaved.innerHTML = '';
  acceptedTags.forEach(tag => {
    const chip = document.createElement('span');
    chip.className = 'tag-chip tag-chip-saved';
    chip.innerHTML = `#${escHtml(tag)} <button class="tag-remove" title="Remove" data-tag="${escHtml(tag)}">×</button>`;
    chip.querySelector('.tag-remove').addEventListener('click', () => removeAcceptedTag(tag));
    tagsSaved.appendChild(chip);
  });
  updateSaveBtn();
}

function acceptTag(tag) {
  pendingTags  = pendingTags.filter(t => t !== tag);
  if (!acceptedTags.includes(tag)) acceptedTags.push(tag);
  tagsDirty = true;
  renderSuggestedChips();
  renderSavedChips();
}

function removeAcceptedTag(tag) {
  acceptedTags = acceptedTags.filter(t => t !== tag);
  tagsDirty = true;
  renderSavedChips();
}

function updateSaveBtn() {
  if (tagsDirty && currentHash) {
    saveTagsBtn.classList.remove('hidden');
  } else {
    saveTagsBtn.classList.add('hidden');
  }
}

addTagBtn.addEventListener('click', addCustomTag);
tagInput.addEventListener('keydown', e => { if (e.key === 'Enter') addCustomTag(); });

function addCustomTag() {
  const raw = tagInput.value.trim().toLowerCase().replace(/[^a-z0-9\-_]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
  if (!raw || acceptedTags.includes(raw)) { tagInput.value = ''; return; }
  acceptedTags.push(raw);
  tagsDirty = true;
  tagInput.value = '';
  renderSavedChips();
}

saveTagsBtn.addEventListener('click', async () => {
  if (!currentHash) return;
  try {
    saveTagsBtn.disabled = true;
    saveTagsBtn.textContent = 'Saving…';
    await fetch(`/api/tags/${currentHash}`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ tags: acceptedTags }),
    });
    tagsDirty = false;
    saveTagsBtn.classList.add('hidden');
    saveTagsBtn.disabled = false;
    saveTagsBtn.innerHTML = `<svg width="14" height="14" viewBox="0 0 14 14" fill="none"><path d="M2 7l4 4 6-6" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg> Save Tags`;
    // dismiss remaining suggestions silently
    pendingTags = [];
    tagsSuggested.classList.add('hidden');
    tagsHint.textContent = acceptedTags.length ? 'Click × to remove · add more below' : 'No tags yet — add some below';
  } catch {
    saveTagsBtn.disabled = false;
    alert('Failed to save tags.');
  }
});

/* ── Export video with overlay ──────────────────────────── */
function resetExportBtn() {
  exportVideoBtn.disabled     = false;
  exportVideoBtn.dataset.mode = 'export';
  exportVideoBtn.dataset.hash = '';
  exportVideoBtn.innerHTML    = `<svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M8 2v7M5 6l3 3 3-3" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/><path d="M2 11v1a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2v-1" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg> Export with Overlay`;
}

function triggerDownload(url, filename) {
  const isMobile = /iPhone|iPad|iPod|Android/i.test(navigator.userAgent);
  if (isMobile) {
    window.open(url, '_blank');
  } else {
    const a = document.createElement('a');
    a.href = url; a.download = filename; a.style.display = 'none';
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
  }
}

exportVideoBtn.addEventListener('click', async () => {
  if (exportVideoBtn.disabled) return;
  const mode = exportVideoBtn.dataset.mode || 'export';

  if (mode === 'download') {
    const hash = exportVideoBtn.dataset.hash;
    const url  = `/api/overlay/${hash}`;
    const isMobile = /iPhone|iPad|iPod|Android/i.test(navigator.userAgent);
    if (isMobile) {
      window.open(url, '_blank');
    } else {
      const a = document.createElement('a');
      a.href = url; a.download = `synthcheck_overlay.mp4`; a.style.display = 'none';
      document.body.appendChild(a); a.click(); document.body.removeChild(a);
    }
    return;
  }

  if (!currentFile) return;
  exportVideoBtn.disabled  = true;
  exportVideoBtn.innerHTML = `<svg width="16" height="16" viewBox="0 0 16 16" fill="none" class="spin-icon"><circle cx="8" cy="8" r="6" stroke="currentColor" stroke-width="1.8" stroke-dasharray="28" stroke-dashoffset="10"/></svg> Rendering…`;

  try {
    const formData = new FormData();
    formData.append('file', currentFile);
    const res = await fetch('/api/export-video', { method: 'POST', body: formData });
    if (!res.ok) {
      const err = await res.json().catch(() => ({ detail: `HTTP ${res.status}` }));
      alert('Export failed: ' + (err.detail || 'Unknown error'));
      return;
    }
    const blob = await res.blob();
    const url  = URL.createObjectURL(blob);
    const stem = currentFile.name.replace(/\.[^.]+$/, '');
    triggerDownload(url, `synthcheck_${stem}.mp4`);
    const isMobile = /iPhone|iPad|iPod|Android/i.test(navigator.userAgent);
    if (!isMobile) URL.revokeObjectURL(url);
    else setTimeout(() => URL.revokeObjectURL(url), 60000);

    if (currentHash) {
      exportVideoBtn.innerHTML    = `<svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M8 2v7M5 6l3 3 3-3" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/><path d="M2 11v1a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2v-1" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg> Download Overlay`;
      exportVideoBtn.dataset.mode = 'download';
      exportVideoBtn.dataset.hash = currentHash;
      exportVideoBtn.disabled     = false;
    } else {
      resetExportBtn();
    }
  } catch {
    alert('Export failed — is the server running?');
    resetExportBtn();
  } finally {
    if (exportVideoBtn.dataset.mode !== 'download') resetExportBtn();
  }
});

/* ── Library ─────────────────────────────────────────────── */
async function refreshLibraryCount() {
  try {
    const res  = await fetch('/api/library');
    const data = await res.json();
    const n    = data.length;
    libraryCountBadge.textContent = n;
    if (n > 0) libraryCountBadge.classList.remove('hidden');
    else libraryCountBadge.classList.add('hidden');
  } catch { /* ignore */ }
}

libraryBtn.addEventListener('click', async () => {
  hide(uploadSection); hide(previewSection); hide(resultsSection);
  hide(errorSection);  hide(loadingSection);
  show(librarySection);
  libActiveType = 'all';
  libActiveTag  = null;
  document.querySelectorAll('.lib-tab').forEach(t => t.classList.toggle('active', t.dataset.type === 'all'));
  await loadLibrary();
});

libraryBackBtn.addEventListener('click', () => {
  hide(librarySection); show(uploadSection);
});

// Type tabs
document.querySelectorAll('.lib-tab').forEach(tab => {
  tab.addEventListener('click', () => {
    libActiveType = tab.dataset.type;
    document.querySelectorAll('.lib-tab').forEach(t => t.classList.toggle('active', t === tab));
    applyLibraryFilter();
  });
});

// Tag filter clear
libTagClearBtn.addEventListener('click', () => {
  libActiveTag = null;
  libTagClearBtn.classList.add('hidden');
  document.querySelectorAll('.lib-tag-chip-filter').forEach(c => c.classList.remove('active'));
  applyLibraryFilter();
});

async function loadLibrary() {
  try {
    const res   = await fetch('/api/library');
    libraryItems = await res.json();
    buildTagFilterBar(libraryItems);
    applyLibraryFilter();
  } catch {
    document.getElementById('libraryGrid').innerHTML =
      '<p style="color:var(--text-muted);text-align:center">Failed to load library.</p>';
  }
}

function buildTagFilterBar(items) {
  // Collect all unique tags across all items
  const tagCount = {};
  items.forEach(item => (item.tags || []).forEach(t => { tagCount[t] = (tagCount[t] || 0) + 1; }));
  const allTags = Object.entries(tagCount).sort((a, b) => b[1] - a[1]).map(([t]) => t);

  libTagChips.innerHTML = '';
  if (!allTags.length) {
    libTagFilter.classList.add('hidden');
    return;
  }
  libTagFilter.classList.remove('hidden');
  allTags.forEach(tag => {
    const chip = document.createElement('button');
    chip.className   = 'lib-tag-chip-filter' + (tag === libActiveTag ? ' active' : '');
    chip.textContent = '#' + tag;
    chip.addEventListener('click', () => {
      libActiveTag = libActiveTag === tag ? null : tag;
      document.querySelectorAll('.lib-tag-chip-filter').forEach(c => c.classList.toggle('active', c.textContent === '#' + libActiveTag));
      libTagClearBtn.classList.toggle('hidden', !libActiveTag);
      applyLibraryFilter();
    });
    libTagChips.appendChild(chip);
  });
}

function applyLibraryFilter() {
  let filtered = libraryItems;
  if (libActiveType !== 'all') filtered = filtered.filter(i => i.type === libActiveType);
  if (libActiveTag)             filtered = filtered.filter(i => (i.tags || []).includes(libActiveTag));
  renderLibrary(filtered);
}

function renderLibrary(items) {
  const grid  = document.getElementById('libraryGrid');
  const empty = document.getElementById('libraryEmpty');
  const total = document.getElementById('libraryTotal');
  grid.innerHTML = '';
  total.textContent = libraryItems.length
    ? `${libraryItems.length} item${libraryItems.length === 1 ? '' : 's'}`
    : '';

  if (!items.length) { empty.classList.remove('hidden'); return; }
  empty.classList.add('hidden');

  items.forEach(item => {
    const card  = document.createElement('div');
    const isAi  = item.is_ai;
    const aiPct = Math.round((item.ai_probability || 0) * 100);
    const isVid = item.type === 'video';
    card.className    = `library-card ${isAi ? 'verdict-ai' : 'verdict-real'}`;
    card.dataset.hash = item.file_hash;

    const thumbHtml = item.thumbnail_url
      ? `<img src="${item.thumbnail_url}" alt="" loading="lazy" />`
      : `<div class="library-no-thumb">${isVid ? '🎞️' : '🖼️'}</div>`;

    const durHtml = isVid && item.duration_seconds
      ? `<span>${formatDuration(item.duration_seconds)}</span> · ` : '';

    const tagsHtml = (item.tags || []).slice(0, 3).map(t =>
      `<span class="lib-card-tag" data-tag="${escHtml(t)}">#${escHtml(t)}</span>`
    ).join('') + ((item.tags || []).length > 3 ? `<span class="lib-card-tag-more">+${item.tags.length - 3}</span>` : '');

    card.innerHTML = `
      <div class="library-card-thumb">
        ${thumbHtml}
        <div class="library-card-badge">${isAi ? '🤖' : '✅'}</div>
        <div class="library-card-score ${isAi ? 'ai' : 'real'}">${aiPct}%</div>
        ${item.overlay_ready ? '<div class="library-overlay-dot" title="Overlay ready">🎬</div>' : ''}
      </div>
      <div class="library-card-info">
        <div class="library-card-name">${escHtml(item.filename)}</div>
        <div class="library-card-meta">${durHtml}<span>${relativeTime(item.analyzed_at)}</span></div>
        ${tagsHtml ? `<div class="lib-card-tags">${tagsHtml}</div>` : ''}
      </div>`;

    // Tag clicks filter library; card click loads result
    card.querySelectorAll('.lib-card-tag[data-tag]').forEach(tagEl => {
      tagEl.addEventListener('click', e => {
        e.stopPropagation();
        const t = tagEl.dataset.tag;
        libActiveTag = libActiveTag === t ? null : t;
        document.querySelectorAll('.lib-tag-chip-filter').forEach(c => c.classList.toggle('active', c.textContent === '#' + libActiveTag));
        libTagClearBtn.classList.toggle('hidden', !libActiveTag);
        applyLibraryFilter();
      });
    });

    card.addEventListener('click', () => loadFromLibrary(item.file_hash));
    grid.appendChild(card);
  });
}

async function loadFromLibrary(hash) {
  try {
    const res = await fetch(`/api/result/${hash}`);
    if (!res.ok) throw new Error();
    const data = await res.json();
    currentFile = null;
    currentHash = hash;
    hide(librarySection); hide(uploadSection);
    renderResults(data);
    show(resultsSection);
  } catch {
    alert('Could not load result.');
  }
}

/* ── Helpers ────────────────────────────────────────────── */
function relativeTime(iso) {
  const d    = new Date(iso.endsWith('Z') ? iso : iso + 'Z');
  const secs = (Date.now() - d) / 1000;
  if (secs < 60)     return 'just now';
  if (secs < 3600)   return `${Math.floor(secs / 60)}m ago`;
  if (secs < 86400)  return `${Math.floor(secs / 3600)}h ago`;
  if (secs < 604800) return `${Math.floor(secs / 86400)}d ago`;
  return d.toLocaleDateString();
}

function escHtml(str) {
  return String(str).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function showError(msg) {
  document.getElementById('errorMsg').textContent = msg;
  show(errorSection); hide(loadingSection); hide(resultsSection);
  hide(previewSection); show(uploadSection);
}

function show(el) { el.classList.remove('hidden'); }
function hide(el) { el.classList.add('hidden'); }
function delay(ms) { return new Promise(r => setTimeout(r, ms)); }

function formatBytes(bytes) {
  if (bytes < 1024)       return bytes + ' B';
  if (bytes < 1024 ** 2)  return (bytes / 1024).toFixed(1) + ' KB';
  if (bytes < 1024 ** 3)  return (bytes / 1024 ** 2).toFixed(1) + ' MB';
  return (bytes / 1024 ** 3).toFixed(1) + ' GB';
}

function formatDuration(seconds) {
  if (!seconds) return '—';
  const m = Math.floor(seconds / 60);
  const s = Math.round(seconds % 60);
  return m === 0 ? `${s}s` : `${m}m ${s}s`;
}
