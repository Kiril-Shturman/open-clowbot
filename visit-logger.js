const http = require('http');
const https = require('https');

const PORT = 9099;
const CHAT_ID = process.env.TELEGRAM_CHAT_ID || '-5293931641';
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';

function isDesktop(ua='') {
  return !/Android|iPhone|iPad|iPod|Mobile/i.test(ua);
}

function nowStr() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2,'0');
  return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function looksPublicIp(ip='') {
  const s = String(ip || '').trim().replace(/^::ffff:/,'');
  if (!s) return false;
  if (s === '127.0.0.1' || s === '::1') return false;
  if (/^10\./.test(s) || /^192\.168\./.test(s) || /^172\.(1[6-9]|2\d|3[0-1])\./.test(s)) return false;
  return true;
}

function pickIp(req) {
  const xff = String(req.headers['x-forwarded-for'] || '');
  const chain = xff.split(',').map(v => v.trim()).filter(Boolean);
  const candidates = [
    ...chain,
    req.headers['x-real-ip'],
    req.headers['cf-connecting-ip'],
    req.headers['true-client-ip'],
    req.headers['x-client-ip'],
    req.socket.remoteAddress
  ].map(v => String(v || '').trim()).filter(Boolean);

  const publicIp = candidates.find(looksPublicIp);
  return { publicIp: publicIp || '', raw: [...new Set(candidates)].join(', ') };
}

function sendTelegram(text) {
  if (!BOT_TOKEN) {
    console.log('[visit-logger] TELEGRAM_BOT_TOKEN missing; skip send');
    return;
  }

  const body = JSON.stringify({
    chat_id: CHAT_ID,
    text,
    disable_web_page_preview: true
  });

  const req = https.request({
    hostname: 'api.telegram.org',
    path: `/bot${BOT_TOKEN}/sendMessage`,
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(body)
    }
  }, (res) => {
    let resp = '';
    res.on('data', (c) => resp += c);
    res.on('end', () => {
      if (res.statusCode >= 200 && res.statusCode < 300) {
        console.log(`[visit-logger] telegram sent ok (${res.statusCode}) chat=${CHAT_ID}`);
      } else {
        console.log(`[visit-logger] telegram send failed (${res.statusCode}) chat=${CHAT_ID} body=${resp.slice(0, 400)}`);
      }
    });
  });

  req.on('error', (err) => {
    console.log('[visit-logger] telegram request error:', err.message);
  });

  req.write(body);
  req.end();
}

const server = http.createServer((req, res) => {
  if (req.method === 'GET' && req.url === '/health') {
    res.statusCode = 200;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  if (req.method !== 'POST' || req.url !== '/__visit') {
    res.statusCode = 404;
    res.end('not found');
    return;
  }

  let buf = '';
  req.on('data', c => buf += c);
  req.on('end', () => {
    let data = {};
    try { data = JSON.parse(buf || '{}'); } catch {}

    const ipInfo = pickIp(req);
    const ua = data.ua || req.headers['user-agent'] || 'unknown';
    const type = isDesktop(ua) ? '🖥 desktop браузер' : '📱 mobile браузер';

    const msg = [
      `🌍 Новый визит (${type})`,
      `⏰ Время: ${nowStr()}`,
      `🌐 IP: ${ipInfo.publicIp || ipInfo.raw || 'unknown'}`,
      `📄 Страница: ${data.path || '/'}`,
      `📱 UserAgent: ${ua}`
    ].join('\n');

    console.log('[visit-logger] visit:', msg.replace(/\n/g, ' | '));
    sendTelegram(msg);

    res.statusCode = 204;
    res.end();
  });
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`visit-logger on 127.0.0.1:${PORT} chat=${CHAT_ID}`);
});
