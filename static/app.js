'use strict';

/* ── State ──────────────────────────────────────────────── */
let currentFile = null;

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
  fileInput.value = '';
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
    renderResults(data);
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

  // Export button — only for videos
  if (data.type === 'video') {
    exportVideoBtn.classList.remove('hidden');
    exportVideoBtn.disabled = false;
    exportVideoBtn.dataset.ready = '1';
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
exportVideoBtn.addEventListener('click', async () => {
  if (!currentFile || exportVideoBtn.disabled) return;

  exportVideoBtn.disabled = true;
  exportVideoBtn.innerHTML = `
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" class="spin-icon">
      <circle cx="8" cy="8" r="6" stroke="currentColor" stroke-width="1.8" stroke-dasharray="28" stroke-dashoffset="10"/>
    </svg>
    Rendering…`;

  try {
    const formData = new FormData();
    formData.append('file', currentFile);

    const res = await fetch('/api/export-video', { method: 'POST', body: formData });

    if (!res.ok) {
      const err = await res.json().catch(() => ({ detail: `HTTP ${res.status}` }));
      alert('Export failed: ' + (err.detail || 'Unknown error'));
      return;
    }

    // Trigger browser download
    const blob     = await res.blob();
    const url      = URL.createObjectURL(blob);
    const a        = document.createElement('a');
    const stem     = currentFile.name.replace(/\.[^.]+$/, '');
    a.href         = url;
    a.download     = `synthcheck_${stem}.mp4`;
    a.style.display = 'none';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  } catch {
    alert('Export failed — is the server running?');
  } finally {
    exportVideoBtn.disabled = false;
    exportVideoBtn.innerHTML = `
      <svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M8 2v7M5 6l3 3 3-3" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/><path d="M2 11v1a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2v-1" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>
      Export with Overlay`;
  }
});

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
