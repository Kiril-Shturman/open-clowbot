const http = require('http');
const https = require('https');
const crypto = require('crypto');

const PORT = Number(process.env.AUTH_PORT || 9292);
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || '';
const DATA = { sessions: new Map() };

function send(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(obj));
}

function parseCookies(req) {
  const raw = req.headers.cookie || '';
  const out = {};
  raw.split(';').forEach(part => {
    const i = part.indexOf('=');
    if (i > -1) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  });
  return out;
}

function readJson(req) {
  return new Promise((resolve) => {
    let buf = '';
    req.on('data', (c) => (buf += c));
    req.on('end', () => {
      try { resolve(JSON.parse(buf || '{}')); } catch { resolve({}); }
    });
  });
}

function verifyGoogleIdToken(idToken) {
  return new Promise((resolve, reject) => {
    const path = `/tokeninfo?id_token=${encodeURIComponent(idToken)}`;
    const req = https.request({ hostname: 'oauth2.googleapis.com', path, method: 'GET' }, (res) => {
      let body = '';
      res.on('data', (c) => (body += c));
      res.on('end', () => {
        try {
          const data = JSON.parse(body || '{}');
          if (res.statusCode !== 200) return reject(new Error(data.error_description || 'google_verify_failed'));
          resolve(data);
        } catch (e) {
          reject(e);
        }
      });
    });
    req.on('error', reject);
    req.end();
  });
}

const server = http.createServer(async (req, res) => {
  if (req.method === 'GET' && req.url === '/health') return send(res, 200, { ok: true });

  if (req.method === 'POST' && req.url === '/api/auth/google') {
    if (!GOOGLE_CLIENT_ID) return send(res, 500, { error: 'GOOGLE_CLIENT_ID_missing' });
    const { credential } = await readJson(req);
    if (!credential) return send(res, 400, { error: 'credential_required' });

    try {
      const tokenInfo = await verifyGoogleIdToken(credential);
      if (tokenInfo.aud !== GOOGLE_CLIENT_ID) return send(res, 401, { error: 'invalid_audience' });

      const sid = crypto.randomBytes(24).toString('hex');
      const user = {
        sub: tokenInfo.sub,
        email: tokenInfo.email,
        email_verified: tokenInfo.email_verified,
        name: tokenInfo.name || tokenInfo.email || 'user',
        picture: tokenInfo.picture || ''
      };
      DATA.sessions.set(sid, { user, createdAt: Date.now() });

      res.setHeader('Set-Cookie', `ocb_session=${sid}; Path=/; HttpOnly; SameSite=Lax; Max-Age=2592000`);
      return send(res, 200, { ok: true, user });
    } catch (e) {
      return send(res, 401, { error: 'google_verify_failed', details: String(e.message || e) });
    }
  }

  if (req.method === 'GET' && req.url === '/api/auth/me') {
    const sid = parseCookies(req).ocb_session;
    if (!sid || !DATA.sessions.has(sid)) return send(res, 401, { ok: false });
    return send(res, 200, { ok: true, user: DATA.sessions.get(sid).user });
  }

  if (req.method === 'POST' && req.url === '/api/auth/logout') {
    const sid = parseCookies(req).ocb_session;
    if (sid) DATA.sessions.delete(sid);
    res.setHeader('Set-Cookie', 'ocb_session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0');
    return send(res, 200, { ok: true });
  }

  send(res, 404, { error: 'not_found' });
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`openclaw-auth-mvp on 127.0.0.1:${PORT}`);
});
