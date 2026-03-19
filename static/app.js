'use strict';

/* ── State ──────────────────────────────────────────────── */
let currentFile = null;
let currentHash = null;

/* ── DOM refs ───────────────────────────────────────────── */
const dropZone        = document.getElementById('dropZone');
const fileInput       = document.getElementById('fileInput');
const uploadSection   = document.getElementById('uploadSection');
const previewSection  = document.getElementById('previewSection');
const previewMediaWrap= document.getElementById('previewMediaWrap');
const previewFilename = document.getElementById('previewFilename');
const previewFilesize = document.getElementById('previewFilesize');
const clearBtn        = document.getElementById('clearBtn');
const analyzeBtn      = document.getElementById('analyzeBtn');
const loadingSection  = document.getElementById('loadingSection');
const resultsSection  = document.getElementById('resultsSection');
const errorSection    = document.getElementById('errorSection');
const errorMsg        = document.getElementById('errorMsg');
const statusText      = document.getElementById('statusText');
const badgeDot        = document.querySelector('.badge-dot');
const exportVideoBtn  = document.getElementById('exportVideoBtn');
const libraryBtn      = document.getElementById('libraryBtn');
const librarySection  = document.getElementById('librarySection');
const libraryBackBtn  = document.getElementById('libraryBackBtn');
const cacheBanner     = document.getElementById('cacheBanner');
const cacheBannerDate = document.getElementById('cacheBannerDate');
const libraryCountBadge = document.getElementById('libraryCountBadge');

/* ── Health check ───────────────────────────────────────── */
async function checkHealth() {
  try {
    const res = await fetch('/api/health');
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
['dragenter', 'dragover'].forEach(evt =>
  dropZone.addEventListener(evt, e => { e.preventDefault(); dropZone.classList.add('drag-over'); })
);
['dragleave', 'drop'].forEach(evt =>
  dropZone.addEventListener(evt, e => { e.preventDefault(); dropZone.classList.remove('drag-over'); })
);
dropZone.addEventListener('drop', e => {
  const file = e.dataTransfer.files[0];
  if (file) setFile(file);
});
dropZone.addEventListener('click', e => {
  if (e.target !== document.querySelector('.browse-link')) fileInput.click();
});
fileInput.addEventListener('change', () => {
  if (fileInput.files[0]) setFile(fileInput.files[0]);
});

/* ── File handling ──────────────────────────────────────── */
function setFile(file) {
  currentFile = file;

  // Build preview
  previewMediaWrap.innerHTML = '';
  const isVideo = file.type.startsWith('video/');
  if (file.type.startsWith('image/')) {
    const img = document.createElement('img');
    img.src = URL.createObjectURL(file);
    previewMediaWrap.appendChild(img);
  } else if (isVideo) {
    const vid = document.createElement('video');
    vid.src = URL.createObjectURL(file);
    vid.muted = true;
    vid.playsInline = true;
    previewMediaWrap.appendChild(vid);
  } else {
    previewMediaWrap.innerHTML = `<svg width="32" height="32" viewBox="0 0 32 32" fill="none"><rect x="4" y="2" width="24" height="28" rx="3" stroke="#6366f1" stroke-width="1.5"/><path d="M10 10h12M10 16h12M10 22h6" stroke="#6366f1" stroke-width="1.5" stroke-linecap="round"/></svg>`;
  }

  previewFilename.textContent = file.name;
  previewFilesize.textContent = formatBytes(file.size);

  show(previewSection);
  hide(uploadSection);
  hide(resultsSection);
  hide(errorSection);
}

function clearFile() {
  currentFile = null;
  currentHash = null;
  fileInput.value = '';
  hide(cacheBanner);
  resetExportBtn();
  show(uploadSection);
  hide(previewSection);
  hide(resultsSection);
  hide(errorSection);
}

clearBtn.addEventListener('click', clearFile);
document.getElementById('resetBtn').addEventListener('click', clearFile);
document.getElementById('errorResetBtn').addEventListener('click', clearFile);

/* ── Analysis ───────────────────────────────────────────── */
analyzeBtn.addEventListener('click', runAnalysis);

async function runAnalysis() {
  if (!currentFile) return;

  hide(previewSection);
  hide(resultsSection);
  hide(errorSection);
  show(loadingSection);

  // Animate loading steps
  const stepDuration = [600, 1200, 1800, 400];
  const steps = ['step1','step2','step3','step4'];
  let stepTimers = [];
  steps.forEach((id, i) => {
    const el = document.getElementById(id);
    el.className = 'step'; // reset
    if (i === 0) el.classList.add('active');
    const delay = stepDuration.slice(0, i).reduce((a, b) => a + b, 0);
    stepTimers.push(setTimeout(() => {
      steps.forEach((sid, j) => {
        const sel = document.getElementById(sid);
        if (j < i) sel.className = 'step done';
        else if (j === i) sel.className = 'step active';
        else sel.className = 'step';
      });
    }, delay));
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
  } catch (e) {
    stepTimers.forEach(clearTimeout);
    hide(loadingSection);
    showError('Network error — is the server running?');
  }
}

/* ── Render results ─────────────────────────────────────── */
function renderResults(data) {
  const isAi = data.is_ai;
  const aiPct = Math.round(data.ai_probability * 100);
  const realPct = Math.round(data.real_probability * 100);
  const confPct = Math.round(data.confidence * 100);

  // Verdict
  const resultCard = document.getElementById('resultCard');
  resultCard.className = 'result-card ' + (isAi ? 'verdict-ai' : 'verdict-real');

  const verdictBadge = document.getElementById('verdictBadge');
  const verdictIcon  = document.getElementById('verdictIcon');
  const verdictLabel = document.getElementById('verdictLabel');
  const verdictSub   = document.getElementById('verdictSub');
  const confValue    = document.getElementById('confidenceValue');

  if (isAi) {
    verdictIcon.innerHTML = '🤖';
    verdictIcon.className = 'verdict-icon ai';
    verdictLabel.textContent = 'AI Generated';
    verdictLabel.className = 'verdict-label ai';
    verdictSub.textContent = `Signs of artificial generation detected`;
    confValue.style.color = 'var(--ai-color)';
  } else {
    verdictIcon.innerHTML = '✅';
    verdictIcon.className = 'verdict-icon real';
    verdictLabel.textContent = 'Real / Authentic';
    verdictLabel.className = 'verdict-label real';
    verdictSub.textContent = `No significant signs of AI generation`;
    confValue.style.color = 'var(--real-color)';
  }
  confValue.textContent = confPct + '%';

  // Probability bars (animate after paint)
  document.getElementById('aiPct').textContent = aiPct + '%';
  document.getElementById('realPct').textContent = realPct + '%';
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      document.getElementById('aiBar').style.width = aiPct + '%';
      document.getElementById('realBar').style.width = realPct + '%';
    });
  });

  // Cache banner
  if (data.cached) {
    cacheBannerDate.textContent = relativeTime(data.analyzed_at);
    cacheBanner.classList.remove('hidden');
  } else {
    cacheBanner.classList.add('hidden');
  }

  // Export button — only for videos
  if (data.type === 'video') {
    exportVideoBtn.classList.remove('hidden');
    if (data.overlay_ready && data.file_hash) {
      // Already exported — offer direct download from library
      exportVideoBtn.innerHTML = `<svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M8 2v7M5 6l3 3 3-3" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/><path d="M2 11v1a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2v-1" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg> Download Overlay`;
      exportVideoBtn.dataset.mode = 'download';
      exportVideoBtn.dataset.hash = data.file_hash;
      exportVideoBtn.disabled = false;
    } else if (!currentFile) {
      // Library result, overlay not yet generated, no source file available
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
    document.getElementById('metaDuration').textContent = formatDuration(data.duration_seconds);
    document.getElementById('metaFps').textContent = data.fps + ' fps';
    document.getElementById('metaFrames').textContent = `${data.frames_analyzed} / ${data.total_frames.toLocaleString()}`;

    const consistency = data.temporal_consistency;
    const consLabel = consistency > 0.85 ? 'High' : consistency > 0.65 ? 'Medium' : 'Low';
    document.getElementById('metaConsistency').textContent = `${consLabel} (${Math.round(consistency * 100)}%)`;
    document.getElementById('axisEnd').textContent = formatDuration(data.duration_seconds);

    renderFrameTimeline(data.frame_results, data.duration_seconds);
  } else {
    videoExtras.classList.add('hidden');
  }

  show(resultsSection);
}

function renderFrameTimeline(frames, duration) {
  const timeline = document.getElementById('frameTimeline');
  timeline.innerHTML = '';
  if (!frames || frames.length === 0) return;

  const maxPct = Math.max(...frames.map(f => Math.max(f.ai_probability, f.real_probability)));

  frames.forEach(f => {
    const bar = document.createElement('div');
    bar.className = 'frame-bar ' + (f.is_ai ? 'ai' : 'real');
    const heightPct = Math.max(15, Math.round((Math.max(f.ai_probability, f.real_probability) / maxPct) * 100));
    bar.style.height = heightPct + '%';
    bar.setAttribute('data-tooltip',
      `${f.verdict} @ ${f.timestamp}s — AI: ${Math.round(f.ai_probability * 100)}%`
    );
    timeline.appendChild(bar);
  });
}

/* ── Export video with overlay ──────────────────────────── */
function resetExportBtn() {
  exportVideoBtn.disabled = false;
  exportVideoBtn.dataset.mode = 'export';
  exportVideoBtn.dataset.hash = '';
  exportVideoBtn.innerHTML = `<svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M8 2v7M5 6l3 3 3-3" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/><path d="M2 11v1a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2v-1" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg> Export with Overlay`;
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

  // Download mode — overlay already exists, just fetch it
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

  // Export mode — upload file and render overlay
  if (!currentFile) return;
  exportVideoBtn.disabled = true;
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

    // Switch button to "Download Overlay" now that it's cached
    if (currentHash) {
      exportVideoBtn.innerHTML = `<svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M8 2v7M5 6l3 3 3-3" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/><path d="M2 11v1a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2v-1" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg> Download Overlay`;
      exportVideoBtn.dataset.mode = 'download';
      exportVideoBtn.dataset.hash = currentHash;
      exportVideoBtn.disabled = false;
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
  await loadLibrary();
});

libraryBackBtn.addEventListener('click', () => {
  hide(librarySection);
  show(uploadSection);
});

async function loadLibrary() {
  try {
    const res   = await fetch('/api/library');
    const items = await res.json();
    renderLibrary(items);
  } catch {
    document.getElementById('libraryGrid').innerHTML =
      '<p style="color:var(--text-muted);text-align:center">Failed to load library.</p>';
  }
}

function renderLibrary(items) {
  const grid  = document.getElementById('libraryGrid');
  const empty = document.getElementById('libraryEmpty');
  const total = document.getElementById('libraryTotal');
  grid.innerHTML = '';
  total.textContent = items.length ? `${items.length} item${items.length === 1 ? '' : 's'}` : '';

  if (!items.length) { empty.classList.remove('hidden'); return; }
  empty.classList.add('hidden');

  items.forEach(item => {
    const card   = document.createElement('div');
    const isAi   = item.is_ai;
    const aiPct  = Math.round((item.ai_probability || 0) * 100);
    const isVid  = item.type === 'video';
    card.className = `library-card ${isAi ? 'verdict-ai' : 'verdict-real'}`;
    card.dataset.hash = item.file_hash;

    const thumbHtml = item.thumbnail_url
      ? `<img src="${item.thumbnail_url}" alt="" loading="lazy" />`
      : `<div class="library-no-thumb">${isVid ? '🎞️' : '🖼️'}</div>`;

    const durHtml = isVid && item.duration_seconds
      ? `<span>${formatDuration(item.duration_seconds)}</span> · ` : '';

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
      </div>`;

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
    hide(librarySection);
    hide(uploadSection);
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
  if (secs < 60)       return 'just now';
  if (secs < 3600)     return `${Math.floor(secs / 60)}m ago`;
  if (secs < 86400)    return `${Math.floor(secs / 3600)}h ago`;
  if (secs < 604800)   return `${Math.floor(secs / 86400)}d ago`;
  return d.toLocaleDateString();
}

function escHtml(str) {
  return str.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

/* ── Error ──────────────────────────────────────────────── */
function showError(msg) {
  document.getElementById('errorMsg').textContent = msg;
  show(errorSection);
  hide(loadingSection);
  hide(resultsSection);
  hide(previewSection);
  show(uploadSection);
}

/* ── Helpers ────────────────────────────────────────────── */
function show(el) { el.classList.remove('hidden'); }
function hide(el) { el.classList.add('hidden'); }
function delay(ms) { return new Promise(r => setTimeout(r, ms)); }

function formatBytes(bytes) {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 ** 2) return (bytes / 1024).toFixed(1) + ' KB';
  if (bytes < 1024 ** 3) return (bytes / 1024 ** 2).toFixed(1) + ' MB';
  return (bytes / 1024 ** 3).toFixed(1) + ' GB';
}

function formatDuration(seconds) {
  if (!seconds) return '—';
  const m = Math.floor(seconds / 60);
  const s = Math.round(seconds % 60);
  if (m === 0) return `${s}s`;
  return `${m}m ${s}s`;
}
