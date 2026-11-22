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

function setResult(kind, label, title, message, data = {}) {
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

async function startCamera() {
  if (!window.Html5Qrcode) {
    setResult('error', 'SCANNER ERROR', 'Camera scanner failed to load', 'Use manual entry or refresh this page.');
    return;
  }
  scanner = scanner || new Html5Qrcode('reader');
  try {
    await scanner.start({ facingMode: 'environment' }, { fps: 10, qrbox: { width: 240, height: 240 } }, onScan);
    cameraRunning = true;
    startButton.hidden = true; stopButton.hidden = false;
    statusEl.textContent = 'Camera live'; statusEl.classList.add('live');
    setResult('neutral', 'READY TO SCAN', 'Point at an attendee QR', 'The result will appear here after a successful scan.');
  } catch (error) {
    setResult('error', 'CAMERA BLOCKED', 'Unable to access the camera', 'Allow camera access in your browser, or use manual entry below.');
  }
}

async function stopCamera() {
  if (scanner && cameraRunning) await scanner.stop();
  cameraRunning = false;
  startButton.hidden = false; stopButton.hidden = true;
  statusEl.textContent = 'Camera off'; statusEl.classList.remove('live');
}

function onScan(token) {
  if (!processing) redeem(token);
}

async function redeem(token) {
  if (processing) return;
  processing = true;
  currentScan = { token: token.trim(), scanId: crypto.randomUUID() };
  if (cameraRunning) await stopCamera();
  setResult('loading', 'VERIFYING GIFT', 'Checking this attendee…', 'Please wait. Do not hand over the gift yet.');
  try {
    const response = await fetch('/api/redeem', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(currentScan)
    });
    const data = await response.json();
    if (data.outcome === 'RECEIVED') {
      setResult('success', 'GIFT RECORDED', 'Hand over the gift', data.message || 'This gift has been recorded.', data);
    } else if (data.outcome === 'ALREADY_RECEIVED') {
      setResult('warning', 'ALREADY RECEIVED', 'Do not give another gift', data.message || 'This person has already received their gift.', data);
    } else {
      setResult('error', data.outcome || 'SCAN NOT ACCEPTED', 'Gift could not be recorded', data.message || 'Please send the attendee to the help desk.', data);
    }
  } catch {
    setResult('error', 'CONNECTION ERROR', 'Could not verify this attendee', 'Check the connection and use “Check QR code” to retry.');
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
