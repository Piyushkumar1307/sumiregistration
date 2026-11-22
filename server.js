const http = require('node:http');
const { readFile } = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

const port = Number(process.env.PORT || 3000);
// Keep this as the precise upstream endpoint supplied by the event API.
// Using a full URL avoids accidentally composing a wrong path from a base URL.
const redeemUrl = process.env.GIFT_REDEEM_URL || 'https://airtelevents.in/api/v1/gift/redeem';
const deviceKey = process.env.GIFT_DEVICE_KEY;
const scannerId = process.env.SCANNER_ID || 'ReceivedItem';
// The gift API identifies this distribution counter as ReceivedItem.
const gateId = process.env.GATE_ID || 'ReceivedItem';
const scannerVersion = process.env.SCANNER_VERSION || '1.0.0';
const publicDir = path.join(__dirname, 'public');

const mimeTypes = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml'
};

function sendJson(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', chunk => {
      raw += chunk;
      if (raw.length > 8192) {
        reject(new Error('Request too large'));
        req.destroy();
      }
    });
    req.on('end', () => {
      try { resolve(JSON.parse(raw || '{}')); } catch { reject(new Error('Invalid JSON')); }
    });
    req.on('error', reject);
  });
}

async function serveFile(res, filePath) {
  try {
    const content = await readFile(filePath);
    res.writeHead(200, {
      'Content-Type': mimeTypes[path.extname(filePath)] || 'application/octet-stream',
      'Cache-Control': 'public, max-age=3600'
    });
    res.end(content);
  } catch {
    sendJson(res, 404, { message: 'Not found' });
  }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  if (req.method === 'GET' && url.pathname === '/health') {
    return sendJson(res, deviceKey ? 200 : 503, {
      status: deviceKey ? 'ready' : 'missing GIFT_DEVICE_KEY',
      scannerId,
      upstream: redeemUrl
    });
  }

  if (req.method === 'POST' && url.pathname === '/api/redeem') {
    if (!deviceKey) return sendJson(res, 503, { message: 'Scanner is not configured. Contact an administrator.' });
    try {
      const { token, scanId } = await readJson(req);
      if (typeof token !== 'string' || !token.startsWith('EVP1.') || token.length > 512) {
        return sendJson(res, 400, { message: 'This QR code is not a valid event pass.' });
      }
      // This mirrors the event team's cURL request. The API generates its own timestamp.
      const payload = {
        token,
        scanId: typeof scanId === 'string' && scanId ? scanId : randomUUID(),
        gateId
      };
      const upstream = await fetch(redeemUrl, {
        method: 'POST',
        headers: { Authorization: `Bearer ${deviceKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(15000)
      });
      const text = await upstream.text();
      let body;
      try { body = JSON.parse(text); } catch { body = { message: 'Gift service returned an invalid response.' }; }
      return sendJson(res, upstream.status, body);
    } catch (error) {
      // QR values and the device key are deliberately never logged.
      return sendJson(res, 502, { message: 'Could not reach the gift service. Please retry this scan.' });
    }
  }

  if (req.method === 'GET' && url.pathname === '/vendor/html5-qrcode.min.js') {
    return serveFile(res, path.join(__dirname, 'node_modules/html5-qrcode/html5-qrcode.min.js'));
  }

  if (req.method === 'GET') {
    const safePath = url.pathname === '/' ? '/index.html' : url.pathname;
    const filePath = path.normalize(path.join(publicDir, safePath));
    if (filePath.startsWith(publicDir + path.sep)) return serveFile(res, filePath);
  }
  sendJson(res, 404, { message: 'Not found' });
});

server.listen(port, () => console.log(`Gift desk scanner listening on port ${port}`));
