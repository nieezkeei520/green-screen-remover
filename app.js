'use strict';

/* ============================================================
   Green Screen Remover — pure client-side chroma key tool
   All processing happens in the visitor's browser.
   No uploads, no server, no account.
   ============================================================ */

const state = {
  mode: 'image',          // 'image' | 'video'
  img: null,               // HTMLImageElement (loaded)
  video: null,             // HTMLVideoElement (loaded)
  srcImageData: null,      // ImageData at natural resolution (original)
  resultCanvas: null,      // offscreen canvas, natural-res result (image mode)
  keyColor: { r: 0, g: 255, b: 0 },
  threshold: 0.18,         // similarity fraction 0..1
  smooth: 4,               // edge smoothing radius (px)
  shrink: 2,               // edge shrink radius (px)
  lastVideoBlob: null,     // Blob from last video processing
  lastVideoIsWebm: false,
};

/* ---------- DOM ---------- */
const $ = (id) => document.getElementById(id);
const drop = $('drop');
const fileInput = $('file');
const fileNameEl = $('fileName');
const keyColorInput = $('keyColor');
const thresholdInput = $('threshold');
const smoothInput = $('smooth');
const shrinkInput = $('shrink');
const thVal = $('thVal');
const smVal = $('smVal');
const shVal = $('shVal');
const fmtRow = $('fmtRow');
const formatSelect = $('format');
const processBtn = $('process');
const downloadBtn = $('download');
const statusEl = $('status');
const preview = $('preview');
const pctx = preview.getContext('2d');

/* ============================================================
   Core chroma-key algorithm (shared by image & video)
   ============================================================ */

// Distance from a pixel to the key color, normalized to 0..1
// 0 = identical to key (should be removed), 1 = opposite.
function colorSimilarity(r, g, b, key) {
  const dr = r - key.r, dg = g - key.g, db = b - key.b;
  return Math.sqrt(dr * dr + dg * dg + db * db) / 441.673; // sqrt(3)*255
}

// Apply chroma key to an RGBA Uint8ClampedArray.
// Returns a new Uint8ClampedArray (RGBA) with alpha baked in.
function applyKey(src, w, h, key, threshold, smooth, shrink) {
  const n = w * h;
  const SOFT = 0.06; // built-in anti-alias ramp (similarity units)
  const alpha = new Uint8ClampedArray(n);

  for (let i = 0; i < n; i++) {
    const p = i * 4;
    const sim = colorSimilarity(src[p], src[p + 1], src[p + 2], key);
    let a;
    if (sim <= threshold) a = 0;
    else if (sim >= threshold + SOFT) a = 255;
    else a = ((sim - threshold) / SOFT) * 255;
    alpha[i] = a;
  }

  if (shrink > 0) erode(alpha, w, h, shrink);
  if (smooth > 0) boxBlur(alpha, w, h, smooth);

  const out = new Uint8ClampedArray(n * 4);
  for (let i = 0; i < n; i++) {
    const p = i * 4;
    out[p] = src[p];
    out[p + 1] = src[p + 1];
    out[p + 2] = src[p + 2];
    out[p + 3] = alpha[i];
  }
  return out;
}

// Separable box blur on a Uint8 alpha array (running-sum, O(w*h)).
function boxBlur(a, w, h, r) {
  if (r <= 0) return;
  const tmp = new Uint8ClampedArray(a.length);
  const win = 2 * r + 1;
  // horizontal
  for (let y = 0; y < h; y++) {
    const row = y * w;
    let acc = 0;
    for (let k = -r; k <= r; k++) acc += a[row + Math.min(Math.max(0, k), w - 1)];
    for (let x = 0; x < w; x++) {
      const add = Math.min(Math.max(0, x + r), w - 1);
      const sub = Math.min(Math.max(0, x - r - 1), w - 1);
      acc += a[row + add] - a[row + sub];
      tmp[row + x] = acc / win;
    }
  }
  // vertical
  for (let x = 0; x < w; x++) {
    let acc = 0;
    for (let k = -r; k <= r; k++) acc += tmp[Math.min(Math.max(0, k), h - 1) * w + x];
    for (let y = 0; y < h; y++) {
      const add = Math.min(Math.max(0, y + r), h - 1);
      const sub = Math.min(Math.max(0, y - r - 1), h - 1);
      acc += tmp[add * w + x] - tmp[sub * w + x];
      a[y * w + x] = acc / win;
    }
  }
}

// Separable min-filter (morphological erosion) on a Uint8 alpha array.
// Pulls the opaque region inward by `r` px — removes green fringe/halo.
function erode(a, w, h, r) {
  if (r <= 0) return;
  const tmp = new Uint8ClampedArray(a.length);
  const q = new Int32Array(2 * r + 4);
  // horizontal min
  for (let y = 0; y < h; y++) {
    const row = y * w;
    let qh = 0, qt = 0;
    for (let x = 0; x < w; x++) {
      while (qh < qt && q[qh] < x - r) qh++;
      while (qh < qt && a[row + q[qt - 1]] >= a[row + x]) qt--;
      q[qt++] = x;
      tmp[row + x] = a[row + q[qh]];
    }
  }
  // vertical min
  for (let x = 0; x < w; x++) {
    let qh = 0, qt = 0;
    for (let y = 0; y < h; y++) {
      while (qh < qt && q[qh] < y - r) qh++;
      while (qh < qt && tmp[q[qt - 1] * w + x] >= tmp[y * w + x]) qt--;
      q[qt++] = y;
      a[y * w + x] = tmp[q[qh] * w + x];
    }
  }
}

/* ============================================================
   Minimal ZIP writer (store method) — for PNG sequence export
   ============================================================ */
let crcTable = null;
function makeCrcTable() {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    t[n] = c >>> 0;
  }
  return t;
}
function crc32(buf) {
  if (!crcTable) crcTable = makeCrcTable();
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) crc = (crc >>> 8) ^ crcTable[(crc ^ buf[i]) & 0xff];
  return (crc ^ 0xffffffff) >>> 0;
}
function makeZip(files) {
  // files: [{ name: string, data: Uint8Array }]
  const enc = new TextEncoder();
  const chunks = [];
  const central = [];
  let offset = 0;
  for (const f of files) {
    const name = enc.encode(f.name);
    const crc = crc32(f.data);
    const size = f.data.length;
    const lh = new Uint8Array(30 + name.length);
    const dv = new DataView(lh.buffer);
    dv.setUint32(0, 0x04034b50, true);
    dv.setUint16(4, 20, true);
    dv.setUint16(6, 0, true);
    dv.setUint16(8, 0, true);
    dv.setUint32(10, 0, true);
    dv.setUint32(12, 0, true);
    dv.setUint32(14, crc, true);
    dv.setUint32(18, size, true);
    dv.setUint32(22, size, true);
    dv.setUint16(26, name.length, true);
    dv.setUint16(28, 0, true);
    lh.set(name, 30);
    chunks.push(lh, f.data);

    const ch = new Uint8Array(46 + name.length);
    const cdv = new DataView(ch.buffer);
    cdv.setUint32(0, 0x02014b50, true);
    cdv.setUint16(4, 20, true);
    cdv.setUint16(6, 20, true);
    cdv.setUint16(8, 0, true);
    cdv.setUint16(10, 0, true);
    cdv.setUint32(12, 0, true);
    cdv.setUint32(14, 0, true);
    cdv.setUint32(16, crc, true);
    cdv.setUint32(20, size, true);
    cdv.setUint32(24, size, true);
    cdv.setUint16(28, name.length, true);
    cdv.setUint32(40, offset, true);
    ch.set(name, 46);
    central.push(ch);
    offset += lh.length + size;
  }
  const eocd = new Uint8Array(22);
  const edv = new DataView(eocd.buffer);
  edv.setUint32(0, 0x06054b50, true);
  edv.setUint16(8, files.length, true);
  edv.setUint16(10, files.length, true);
  let cdSize = 0;
  for (const c of central) cdSize += c.length;
  edv.setUint32(12, cdSize, true);
  edv.setUint32(16, offset, true);
  chunks.push(...central, eocd);
  return new Blob(chunks, { type: 'application/zip' });
}

/* ============================================================
   Image mode
   ============================================================ */
function loadImageFile(file) {
  const url = URL.createObjectURL(file);
  const img = new Image();
  img.onload = () => {
    state.img = img;
    state.video = null;
    const w = img.naturalWidth, h = img.naturalHeight;
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    c.getContext('2d').drawImage(img, 0, 0);
    state.srcImageData = c.getContext('2d').getImageData(0, 0, w, h);
    state.resultCanvas = document.createElement('canvas');
    state.resultCanvas.width = w; state.resultCanvas.height = h;
    fileNameEl.textContent = file.name + '  (' + w + '×' + h + ')';
    processBtn.disabled = false;
    renderImagePreview();
    statusEl.textContent = 'Ready. Adjust the sliders — preview updates live.';
    URL.revokeObjectURL(url);
  };
  img.onerror = () => {
    statusEl.textContent = 'Could not load that image.';
    URL.revokeObjectURL(url);
  };
  img.src = url;
}

// Re-apply key to the source and refresh the preview canvas (live).
function renderImagePreview() {
  if (!state.srcImageData) return;
  const w = state.srcImageData.width, h = state.srcImageData.height;
  const out = applyKey(state.srcImageData.data, w, h,
    state.keyColor, state.threshold, state.smooth, state.shrink);
  const rc = state.resultCanvas;
  rc.getContext('2d').putImageData(new ImageData(out, w, h), 0, 0);

  // scaled preview
  const maxW = preview.parentElement.clientWidth - 16;
  const scale = Math.min(1, maxW / w);
  preview.width = Math.round(w * scale);
  preview.height = Math.round(h * scale);
  pctx.clearRect(0, 0, preview.width, preview.height);
  pctx.drawImage(rc, 0, 0, preview.width, preview.height);
  downloadBtn.classList.remove('hidden');
}

/* ============================================================
   Video mode
   ============================================================ */
function loadVideoFile(file) {
  const url = URL.createObjectURL(file);
  const v = document.createElement('video');
  v.muted = true;
  v.playsInline = true;
  v.preload = 'auto';
  v.onloadedmetadata = () => {
    state.video = v;
    state.img = null;
    state.srcImageData = null;
    state.lastVideoBlob = null;
    fileNameEl.textContent = file.name + '  (' + v.videoWidth + '×' + v.videoHeight + ', ' +
      (isFinite(v.duration) ? v.duration.toFixed(1) + 's' : 'live') + ')';
    processBtn.disabled = false;
    downloadBtn.classList.add('hidden');
    statusEl.textContent = 'Ready. Click Process to key the whole clip.';
    // show first frame as poster
    v.currentTime = 0;
    const tryFrame = () => {
      const c = document.createElement('canvas');
      c.width = v.videoWidth; c.height = v.videoHeight;
      c.getContext('2d').drawImage(v, 0, 0);
      const maxW = preview.parentElement.clientWidth - 16;
      const scale = Math.min(1, maxW / v.videoWidth);
      preview.width = Math.round(v.videoWidth * scale);
      preview.height = Math.round(v.videoHeight * scale);
      pctx.clearRect(0, 0, preview.width, preview.height);
      pctx.drawImage(c, 0, 0, preview.width, preview.height);
    };
    if (v.readyState >= 2) tryFrame();
    else v.onloadeddata = tryFrame;
  };
  v.onerror = () => {
    statusEl.textContent = 'Could not load that video.';
    URL.revokeObjectURL(url);
  };
  v.src = url;
}

function pickMime() {
  const cands = ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm'];
  if (typeof MediaRecorder === 'undefined') return '';
  for (const c of cands) if (MediaRecorder.isTypeSupported(c)) return c;
  return '';
}

async function processVideo() {
  const v = state.video;
  if (!v) return;
  const w = v.videoWidth, h = v.videoHeight;
  const canvas = document.createElement('canvas');
  canvas.width = w; canvas.height = h;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  const fmt = formatSelect.value;
  const fps = 30;
  const frameDur = 1 / fps;

  processBtn.disabled = true;
  statusEl.textContent = 'Processing…';

  const finishFrame = (t) => {
    ctx.drawImage(v, 0, 0, w, h);
    const sd = ctx.getImageData(0, 0, w, h);
    const out = applyKey(sd.data, w, h, state.keyColor, state.threshold, state.smooth, state.shrink);
    ctx.putImageData(new ImageData(out, w, h), 0, 0);
    return t;
  };

  if (fmt === 'webm') {
    const mime = pickMime();
    if (!mime) {
      statusEl.textContent = 'This browser cannot record transparent WebM. Use PNG sequence instead.';
      processBtn.disabled = false;
      return;
    }
    const stream = canvas.captureStream(fps);
    const rec = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: 12_000_000 });
    const chunks = [];
    rec.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data); };
    const stopped = new Promise((res) => { rec.onstop = res; });

    v.currentTime = 0;
    await v.play();
    rec.start();
    await new Promise((resolve) => {
      let last = -1;
      const step = () => {
        if (v.ended || v.paused) { resolve(); return; }
        const t = v.currentTime;
        if (t - last >= frameDur - 1e-3) { last = t; finishFrame(t); }
        requestAnimationFrame(step);
      };
      requestAnimationFrame(step);
    });
    v.pause();
    rec.stop();
    await stopped;
    const blob = new Blob(chunks, { type: mime });
    state.lastVideoBlob = blob;
    state.lastVideoIsWebm = true;
    showVideoResult(blob, true);
  } else {
    // PNG sequence
    const frames = [];
    v.currentTime = 0;
    await v.play();
    await new Promise((resolve) => {
      let last = -1;
      const step = () => {
        if (v.ended || v.paused) { resolve(); return; }
        const t = v.currentTime;
        if (t - last >= frameDur - 1e-3) {
          last = t;
          finishFrame(t);
          frames.push(new Promise((res) =>
            canvas.toBlob((b) => res({ name: 'frame_' + String(frames.length).padStart(4, '0') + '.png', blob: b }), 'image/png')));
        }
        requestAnimationFrame(step);
      };
      requestAnimationFrame(step);
    });
    v.pause();
    const collected = await Promise.all(frames);
    const files = await Promise.all(collected.map((f) =>
      f.blob.arrayBuffer().then((d) => ({ name: f.name, data: new Uint8Array(d) }))));
    const zip = makeZip(files);
    state.lastVideoBlob = zip;
    state.lastVideoIsWebm = false;
    showVideoResult(zip, false, files.length);
  }
}

function showVideoResult(blob, isWebm, frameCount) {
  const wrap = preview.parentElement;
  const oldVid = wrap.querySelector('video.result-vid');
  if (oldVid) { URL.revokeObjectURL(oldVid.src); oldVid.remove(); }
  if (isWebm) {
    const vid = document.createElement('video');
    vid.className = 'result-vid';
    vid.src = URL.createObjectURL(blob);
    vid.controls = true;
    vid.style.maxWidth = '100%';
    preview.style.display = 'none';
    wrap.appendChild(vid);
    statusEl.textContent = 'Done — transparent WebM ready. Download it.';
  } else {
    preview.style.display = '';
    statusEl.textContent = 'Done — ' + frameCount + ' PNG frames zipped. Download the .zip.';
  }
  downloadBtn.classList.remove('hidden');
  processBtn.disabled = false;
}

/* ============================================================
   Download
   ============================================================ */
async function downloadResult() {
  if (state.mode === 'image' && state.resultCanvas) {
    state.resultCanvas.toBlob((blob) => {
      triggerDownload(blob, 'green-screen-removed.png');
    }, 'image/png');
  } else if (state.mode === 'video' && state.lastVideoBlob) {
    triggerDownload(state.lastVideoBlob, state.lastVideoIsWebm ? 'green-screen-removed.webm' : 'green-screen-frames.zip');
  }
}
function triggerDownload(blob, name) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

/* ============================================================
   UI wiring
   ============================================================ */
function setMode(mode) {
  state.mode = mode;
  $('tabImage').classList.toggle('active', mode === 'image');
  $('tabVideo').classList.toggle('active', mode === 'video');
  fmtRow.classList.toggle('hidden', mode !== 'video');
  fileInput.accept = mode === 'image' ? 'image/*' : 'video/*';
  // reset
  state.img = null; state.video = null; state.srcImageData = null;
  state.lastVideoBlob = null;
  fileNameEl.textContent = '';
  processBtn.disabled = true;
  downloadBtn.classList.add('hidden');
  statusEl.textContent = '';
  const wrap = preview.parentElement;
  const oldVid = wrap.querySelector('video.result-vid');
  if (oldVid) { URL.revokeObjectURL(oldVid.src); oldVid.remove(); }
  preview.style.display = '';
  pctx.clearRect(0, 0, preview.width, preview.height);
  if (mode === 'video') fileInput.accept = 'video/*';
  else fileInput.accept = 'image/*';
}

function syncLabels() {
  thVal.textContent = thresholdInput.value + '%';
  smVal.textContent = smoothInput.value + ' px';
  shVal.textContent = shrinkInput.value + ' px';
}

thresholdInput.addEventListener('input', () => {
  state.threshold = +thresholdInput.value / 100;
  syncLabels();
  if (state.mode === 'image' && state.srcImageData) renderImagePreview();
});
smoothInput.addEventListener('input', () => {
  state.smooth = +smoothInput.value;
  syncLabels();
  if (state.mode === 'image' && state.srcImageData) renderImagePreview();
});
shrinkInput.addEventListener('input', () => {
  state.shrink = +shrinkInput.value;
  syncLabels();
  if (state.mode === 'image' && state.srcImageData) renderImagePreview();
});

keyColorInput.addEventListener('input', () => {
  const hex = keyColorInput.value;
  state.keyColor = hexToRgb(hex);
});
$('presetGreen').addEventListener('click', () => setKey('#00ff00'));
$('presetBlue').addEventListener('click', () => setKey('#0000ff'));
function setKey(hex) {
  keyColorInput.value = hex;
  state.keyColor = hexToRgb(hex);
  if (state.mode === 'image' && state.srcImageData) renderImagePreview();
}
function hexToRgb(hex) {
  const m = hex.replace('#', '');
  return {
    r: parseInt(m.substring(0, 2), 16),
    g: parseInt(m.substring(2, 4), 16),
    b: parseInt(m.substring(4, 6), 16),
  };
}

// Eyedropper: click preview to sample key color
preview.addEventListener('click', (e) => {
  if (state.mode !== 'image' || !state.srcImageData) return;
  const rect = preview.getBoundingClientRect();
  const x = Math.round(((e.clientX - rect.left) / rect.width) * state.srcImageData.width);
  const y = Math.round(((e.clientY - rect.top) / rect.height) * state.srcImageData.height);
  const i = (y * state.srcImageData.width + x) * 4;
  const d = state.srcImageData.data;
  const hex = rgbToHex(d[i], d[i + 1], d[i + 2]);
  setKey(hex);
  statusEl.textContent = 'Key color sampled: ' + hex;
});
function rgbToHex(r, g, b) {
  return '#' + [r, g, b].map((v) => v.toString(16).padStart(2, '0')).join('');
}

// File input / drop
$('browse').addEventListener('click', (e) => { e.stopPropagation(); fileInput.click(); });
drop.addEventListener('click', () => fileInput.click());
fileInput.addEventListener('change', () => {
  if (fileInput.files[0]) handleFile(fileInput.files[0]);
});
['dragenter', 'dragover'].forEach((ev) =>
  drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add('hover'); }));
['dragleave', 'drop'].forEach((ev) =>
  drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.remove('hover'); }));
drop.addEventListener('drop', (e) => {
  const f = e.dataTransfer.files[0];
  if (f) handleFile(f);
});
function handleFile(file) {
  if (file.type.startsWith('video')) {
    if (state.mode !== 'video') setMode('video');
    loadVideoFile(file);
  } else {
    if (state.mode !== 'image') setMode('image');
    loadImageFile(file);
  }
}

processBtn.addEventListener('click', () => {
  if (state.mode === 'image') {
    renderImagePreview();
    statusEl.textContent = 'Processed. Download your transparent PNG.';
  } else {
    processVideo();
  }
});
downloadBtn.addEventListener('click', downloadResult);

$('tabImage').addEventListener('click', () => setMode('image'));
$('tabVideo').addEventListener('click', () => setMode('video'));

// init
syncLabels();
setMode('image');

// debug hook (read-only): lets automated tests inspect the result canvas
window.__gsr = state;
