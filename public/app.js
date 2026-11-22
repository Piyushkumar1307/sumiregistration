const startButton = document.querySelector('#start-camera');
const stopButton = document.querySelector('#stop-camera');
const nextButton = document.querySelector('#scan-next');
const statusEl = document.querySelector('#camera-status');
const resultEl = document.querySelector('#result');
const iconEl = document.querySelector('#result-icon');
const labelEl = document.querySelector('#result-label');
const titleEl = document.querySelector('#result-title');
const messageEl = document.querySelector('#result-message');
const detailsEl = document.querySelector('#attendee-details');
const manualForm = document.querySelector('#manual-form');

let scanner;
let cameraRunning = false;
let processing = false;
let currentScan = null;
// After a connection problem we remember the scan so a retry sends the SAME scanId. The server then
// answers "recorded" instead of "already received" if the first attempt actually got through.
let pendingAttempt = null;
let wakeLock = null;

async function keepScreenAwake() {
  try {
    if ('wakeLock' in navigator && !wakeLock) {
      wakeLock = await navigator.wakeLock.request('screen');
      wakeLock.addEventListener('release', () => { wakeLock = null; });
    }
  } catch { /* not supported or denied */ }
}
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && cameraRunning) keepScreenAwake();
});

function buzz(kind) {
  // Short buzz for a gift, double buzz for already-received / errors. Ignored where unsupported.
  try { navigator.vibrate?.(kind === 'success' ? 120 : kind === 'warning' || kind === 'error' ? [90, 60, 90] : 0); } catch { /* ignore */ }
}

function setResult(kind, label, title, message, data = {}) {
  document.querySelector('#retry-scan')?.remove();
  if (kind === 'success' || kind === 'warning' || kind === 'error') buzz(kind);
  resultEl.className = `result ${kind}`;
  iconEl.textContent = kind === 'success' ? '✓' : kind === 'warning' ? '!' : kind === 'error' ? '×' : '⌁';
  labelEl.textContent = label;
  titleEl.textContent = title;
  messageEl.textContent = message;
  const attendee = data.attendee;
  if (attendee) {
    const received = data.receivedAt ? new Date(data.receivedAt).toLocaleString() : null;
    detailsEl.innerHTML = `
      <div><dt>Attendee</dt><dd>${escapeHtml(attendee.name || '—')}</dd></div>
      <div><dt>OLM ID</dt><dd>${escapeHtml(attendee.employeeCode || '—')}</dd></div>
      <div><dt>Group</dt><dd>${escapeHtml(attendee.group || '—')}</dd></div>
      ${received ? `<div><dt>Received</dt><dd>${escapeHtml(received)}${data.receivedBy ? ` · ${escapeHtml(data.receivedBy)}` : ''}</dd></div>` : ''}`;
    detailsEl.hidden = false;
  } else detailsEl.hidden = true;
  nextButton.hidden = kind === 'neutral' || kind === 'loading';
}

function escapeHtml(value) {
  return String(value).replace(/[&<>'"]/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' })[char]);
}

/* ---------------------------------------------------------------------------------------------
 * Camera engines
 *
 * 1) Native (Android Chrome and any browser with BarcodeDetector): the phone's own QR reader looks
 *    at the WHOLE camera picture, at a 1080p stream with continuous autofocus. No small scan box,
 *    so the QR is read from arm's length instead of having to be held very close. Zoom and torch
 *    controls appear when the camera supports them.
 * 2) Fallback (browsers without BarcodeDetector): the html5-qrcode library with tuned settings.
 * ------------------------------------------------------------------------------------------- */
const readerEl = document.querySelector('#reader');
let nativeDetector = null;
let nativeStream = null;
let nativeVideo = null;
let nativeTimer = null;
let nativeActive = false;

async function nativeReaderAvailable() {
  if (!('BarcodeDetector' in window)) return false;
  try {
    const formats = await BarcodeDetector.getSupportedFormats();
    if (!formats.includes('qr_code')) return false;
    nativeDetector = nativeDetector || new BarcodeDetector({ formats: ['qr_code'] });
    return true;
  } catch {
    return false;
  }
}

function addCameraControls(track) {
  const caps = typeof track.getCapabilities === 'function' ? track.getCapabilities() : {};
  const box = document.createElement('div');
  box.className = 'camera-controls';
  box.style.cssText = 'display:flex;gap:.75rem;align-items:center;flex-wrap:wrap;margin-top:.6rem';
  if (caps.zoom && caps.zoom.max > caps.zoom.min) {
    const label = document.createElement('label');
    label.textContent = 'Zoom';
    label.style.cssText = 'display:flex;gap:.5rem;align-items:center;font-weight:600;flex:1 1 12rem';
    const range = document.createElement('input');
    range.type = 'range';
    range.min = caps.zoom.min;
    range.max = Math.min(caps.zoom.max, caps.zoom.min * 4);
    range.step = caps.zoom.step || 0.1;
    range.value = caps.zoom.min;
    range.style.flex = '1';
    range.addEventListener('input', () => {
      track.applyConstraints({ advanced: [{ zoom: Number(range.value) }] }).catch(() => {});
    });
    label.appendChild(range);
    box.appendChild(label);
  }
  if (caps.torch) {
    let on = false;
    const torch = document.createElement('button');
    torch.type = 'button';
    torch.className = 'secondary';
    torch.textContent = 'Light off';
    torch.addEventListener('click', async () => {
      on = !on;
      try {
        await track.applyConstraints({ advanced: [{ torch: on }] });
        torch.textContent = on ? 'Light on' : 'Light off';
      } catch { on = !on; }
    });
    box.appendChild(torch);
  }
  if (box.childElementCount) {
    box.id = 'camera-controls';
    readerEl.insertAdjacentElement('afterend', box);
  }
}

/** Starts reading QR codes from a camera MediaStream with the native detector. */
async function startNative(mediaStream) {
  nativeStream = mediaStream;
  const track = mediaStream.getVideoTracks()[0];
  try { await track.applyConstraints({ advanced: [{ focusMode: 'continuous' }] }); } catch { /* not supported */ }
  readerEl.innerHTML = '';
  nativeVideo = document.createElement('video');
  nativeVideo.setAttribute('playsinline', '');
  nativeVideo.muted = true;
  nativeVideo.autoplay = true;
  nativeVideo.style.cssText = 'width:100%;max-height:70vh;object-fit:cover';
  nativeVideo.srcObject = mediaStream;
  readerEl.appendChild(nativeVideo);
  await nativeVideo.play();
  addCameraControls(track);
  nativeActive = true;
  const tick = async () => {
    if (!nativeActive) return;
    try {
      if (!processing && nativeVideo.readyState >= 2) {
        const found = await nativeDetector.detect(nativeVideo);
        const hit = found.find((b) => typeof b.rawValue === 'string' && b.rawValue.startsWith('EVP1.'));
        if (hit) onScan(hit.rawValue);
      }
    } catch { /* frame not ready yet */ }
    if (nativeActive) nativeTimer = setTimeout(tick, 50);
  };
  tick();
}

function stopNative() {
  nativeActive = false;
  clearTimeout(nativeTimer);
  if (nativeStream) nativeStream.getTracks().forEach((t) => t.stop());
  nativeStream = null;
  if (nativeVideo) nativeVideo.srcObject = null;
  nativeVideo = null;
  document.querySelector('#camera-controls')?.remove();
  readerEl.innerHTML = '';
}

function showCameraLive() {
  cameraRunning = true;
  keepScreenAwake();
  startButton.hidden = true; stopButton.hidden = false;
  statusEl.textContent = 'Camera live'; statusEl.classList.add('live');
  setResult('neutral', 'READY TO SCAN', 'Point at an attendee QR', 'The result will appear here after a successful scan.');
}

function showCameraBlocked() {
  setResult('error', 'CAMERA BLOCKED', 'Unable to access the camera', 'Allow camera access in your browser, or use manual entry below.');
}

/** Settings for the html5-qrcode fallback (browsers without BarcodeDetector). */
function scanConfig() {
  return {
    fps: 25,
    qrbox: (viewWidth, viewHeight) => {
      const side = Math.floor(Math.min(viewWidth, viewHeight) * 0.85);
      return { width: side, height: side };
    },
    disableFlip: true,
    formatsToSupport: [Html5QrcodeSupportedFormats.QR_CODE],
    experimentalFeatures: { useBarcodeDetector: true },
    videoConstraints: { facingMode: 'environment', width: { ideal: 1920 }, height: { ideal: 1080 } }
  };
}

async function startCamera() {
  if (await nativeReaderAvailable()) {
    try {
      const media = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: { facingMode: { ideal: 'environment' }, width: { ideal: 1920 }, height: { ideal: 1080 } }
      });
      await startNative(media);
      showCameraLive();
      return;
    } catch (error) {
      if (error && (error.name === 'NotAllowedError' || error.name === 'SecurityError')) return showCameraBlocked();
      stopNative(); // anything else: fall back to the library below
    }
  }
  if (!window.Html5Qrcode) {
    setResult('error', 'SCANNER ERROR', 'Camera scanner failed to load', 'Use manual entry or refresh this page.');
    return;
  }
  scanner = scanner || new Html5Qrcode('reader');
  try {
    await scanner.start({ facingMode: 'environment' }, scanConfig(), onScan);
    try { await scanner.applyVideoConstraints({ advanced: [{ focusMode: 'continuous' }] }); } catch { /* optional */ }
    showCameraLive();
  } catch (error) {
    showCameraBlocked();
  }
}

async function stopCamera() {
  if (nativeActive) stopNative();
  else if (scanner && cameraRunning) await scanner.stop();
  cameraRunning = false;
  startButton.hidden = false; stopButton.hidden = true;
  statusEl.textContent = 'Camera off'; statusEl.classList.remove('live');
}

function onScan(token) {
  if (!processing) redeem(token);
}

function offerRetry() {
  const button = document.createElement('button');
  button.id = 'retry-scan';
  button.className = 'primary';
  button.textContent = 'Retry this QR';
  button.addEventListener('click', () => pendingAttempt && redeem(pendingAttempt.token));
  resultEl.appendChild(button);
}

async function redeem(token) {
  if (processing) return;
  processing = true;
  token = String(token).trim();
  // Same QR retried after a connection problem keeps the same scanId; anything else gets a new one.
  const scanId = pendingAttempt && pendingAttempt.token === token ? pendingAttempt.scanId : crypto.randomUUID();
  pendingAttempt = null;
  currentScan = { token, scanId };
  if (cameraRunning) await stopCamera();
  setResult('loading', 'VERIFYING GIFT', 'Checking this attendee…', 'Please wait. Do not hand over the gift yet.');
  try {
    const response = await fetch('/api/redeem', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(currentScan),
      signal: AbortSignal.timeout(15000)
    });
    const data = await response.json();
    if (response.status >= 500 && !data.outcome) throw new Error('upstream unavailable');
    if (data.outcome === 'RECEIVED') {
      setResult('success', 'GIFT RECORDED', 'Hand over the gift', data.message || 'This gift has been recorded.', data);
    } else if (data.outcome === 'ALREADY_RECEIVED') {
      setResult('warning', 'ALREADY RECEIVED', 'Do not give another gift', data.message || 'This person has already received their gift.', data);
    } else {
      setResult('error', data.outcome || 'SCAN NOT ACCEPTED', 'Gift could not be recorded', data.message || 'Please send the attendee to the help desk.', data);
    }
  } catch {
    pendingAttempt = currentScan;
    setResult('error', 'CONNECTION ERROR', 'Could not verify this attendee', 'Check the connection, then retry. The same QR is safe to retry; it cannot give a second gift.');
    nextButton.hidden = true;
    offerRetry();
  } finally { processing = false; }
}

startButton.addEventListener('click', startCamera);
stopButton.addEventListener('click', stopCamera);
nextButton.addEventListener('click', () => {
  currentScan = null;
  setResult('neutral', 'READY TO SCAN', 'Awaiting an attendee', 'Start the camera, then scan the next QR.');
  startCamera();
});
manualForm.addEventListener('submit', event => {
  event.preventDefault();
  redeem(new FormData(manualForm).get('token'));
});
