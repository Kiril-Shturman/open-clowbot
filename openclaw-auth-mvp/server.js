const http = require('http');
const https = require('https');
const crypto = require('crypto');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

const PORT = Number(process.env.AUTH_PORT || 9292);
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || '';
const DB_PATH = process.env.AUTH_DB_PATH || path.join(__dirname, 'auth.db');

const db = new DatabaseSync(DB_PATH);
db.exec('PRAGMA journal_mode = WAL;');
db.exec('PRAGMA foreign_keys = ON;');

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT UNIQUE NOT NULL,
  password_hash TEXT,
  google_sub TEXT UNIQUE,
  name TEXT,
  picture TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS bots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  name TEXT NOT NULL,
  telegram_username TEXT,
  channel TEXT NOT NULL DEFAULT 'telegram',
  status TEXT NOT NULL DEFAULT 'active',
  created_at TEXT NOT NULL,
  FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
);
`);

function nowIso() { return new Date().toISOString(); }

function send(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(obj));
}

function readJson(req) {
  return new Promise((resolve) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      try { resolve(JSON.parse(body || '{}')); } catch { resolve({}); }
    });
  });
}

function parseCookies(req) {
  const raw = req.headers.cookie || '';
  const out = {};
  raw.split(';').forEach((part) => {
    const i = part.indexOf('=');
    if (i > -1) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  });
  return out;
}

function setSessionCookie(res, token) {
  // secure works on HTTPS production
  res.setHeader('Set-Cookie', `ocb_session=${token}; Path=/; HttpOnly; SameSite=Lax; Secure; Max-Age=2592000`);
}

function clearSessionCookie(res) {
  res.setHeader('Set-Cookie', 'ocb_session=; Path=/; HttpOnly; SameSite=Lax; Secure; Max-Age=0');
}

function randomToken() {
  return crypto.randomBytes(24).toString('hex');
}

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return `${salt}:${hash}`;
}

function verifyPassword(password, stored) {
  if (!stored || !stored.includes(':')) return false;
  const [salt, hash] = stored.split(':');
  const candidate = crypto.scryptSync(password, salt, 64).toString('hex');
  return crypto.timingSafeEqual(Buffer.from(hash, 'hex'), Buffer.from(candidate, 'hex'));
}

function verifyGoogleIdToken(idToken) {
  return new Promise((resolve, reject) => {
    const p = `/tokeninfo?id_token=${encodeURIComponent(idToken)}`;
    const req = https.request({ hostname: 'oauth2.googleapis.com', path: p, method: 'GET' }, (res) => {
      let body = '';
      res.on('data', (c) => (body += c));
      res.on('end', () => {
        try {
          const data = JSON.parse(body || '{}');
          if (res.statusCode !== 200) return reject(new Error(data.error_description || 'google_verify_failed'));
          resolve(data);
        } catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.end();
  });
}

function getUserBySession(req) {
  const token = parseCookies(req).ocb_session;
  if (!token) return null;
  const row = db.prepare(`
    SELECT u.id, u.email, u.name, u.picture, s.token, s.expires_at
    FROM sessions s
    JOIN users u ON u.id = s.user_id
    WHERE s.token = ?
  `).get(token);
  if (!row) return null;
  if (new Date(row.expires_at).getTime() < Date.now()) {
    db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
    return null;
  }
  return row;
}

function createDefaultBotsIfEmpty(userId) {
  const count = db.prepare('SELECT COUNT(*) as c FROM bots WHERE user_id = ?').get(userId).c;
  if (count > 0) return;
  const stmt = db.prepare('INSERT INTO bots (user_id,name,telegram_username,channel,status,created_at) VALUES (?,?,?,?,?,?)');
  const now = nowIso();
  stmt.run(userId, 'sales_assistant_bot', '@sales_assistant_bot', 'telegram', 'active', now);
  stmt.run(userId, 'support_helper_bot', '@support_helper_bot', 'telegram', 'paused', now);
}

const server = http.createServer(async (req, res) => {
  if (req.method === 'GET' && req.url === '/health') return send(res, 200, { ok: true, db: DB_PATH });

  // Register email/password
  if (req.method === 'POST' && req.url === '/api/auth/register') {
    const { email, password, name } = await readJson(req);
    if (!email || !password) return send(res, 400, { error: 'email_and_password_required' });
    if (String(password).length < 6) return send(res, 400, { error: 'password_too_short' });

    const now = nowIso();
    try {
      const result = db.prepare(
        'INSERT INTO users (email,password_hash,name,created_at,updated_at) VALUES (?,?,?,?,?)'
      ).run(String(email).toLowerCase().trim(), hashPassword(password), name || '', now, now);

      const userId = Number(result.lastInsertRowid);
      createDefaultBotsIfEmpty(userId);

      const token = randomToken();
      const expires = new Date(Date.now() + 30 * 24 * 3600 * 1000).toISOString();
      db.prepare('INSERT INTO sessions (token,user_id,created_at,expires_at) VALUES (?,?,?,?)').run(token, userId, now, expires);
      setSessionCookie(res, token);

      return send(res, 200, { ok: true, user: { id: userId, email, name: name || '' } });
    } catch (e) {
      if (String(e.message).includes('UNIQUE')) return send(res, 409, { error: 'email_already_exists' });
      return send(res, 500, { error: 'register_failed', details: String(e.message || e) });
    }
  }

  // Login email/password
  if (req.method === 'POST' && req.url === '/api/auth/login') {
    const { email, password } = await readJson(req);
    if (!email || !password) return send(res, 400, { error: 'email_and_password_required' });

    const user = db.prepare('SELECT id,email,name,picture,password_hash FROM users WHERE email = ?').get(String(email).toLowerCase().trim());
    if (!user || !verifyPassword(password, user.password_hash)) return send(res, 401, { error: 'invalid_credentials' });

    const token = randomToken();
    const now = nowIso();
    const expires = new Date(Date.now() + 30 * 24 * 3600 * 1000).toISOString();
    db.prepare('INSERT INTO sessions (token,user_id,created_at,expires_at) VALUES (?,?,?,?)').run(token, user.id, now, expires);
    setSessionCookie(res, token);

    createDefaultBotsIfEmpty(user.id);
    return send(res, 200, { ok: true, user: { id: user.id, email: user.email, name: user.name || '', picture: user.picture || '' } });
  }

  // Google login
  if (req.method === 'POST' && req.url === '/api/auth/google') {
    if (!GOOGLE_CLIENT_ID) return send(res, 500, { error: 'GOOGLE_CLIENT_ID_missing' });
    const { credential } = await readJson(req);
    if (!credential) return send(res, 400, { error: 'credential_required' });

    try {
      const t = await verifyGoogleIdToken(credential);
      if (t.aud !== GOOGLE_CLIENT_ID) return send(res, 401, { error: 'invalid_audience' });

      const email = String(t.email || '').toLowerCase().trim();
      if (!email) return send(res, 401, { error: 'google_email_missing' });

      const now = nowIso();
      let user = db.prepare('SELECT id,email,name,picture FROM users WHERE email = ?').get(email);
      if (!user) {
        const ins = db.prepare('INSERT INTO users (email,google_sub,name,picture,created_at,updated_at) VALUES (?,?,?,?,?,?)')
          .run(email, t.sub || null, t.name || email, t.picture || '', now, now);
        user = { id: Number(ins.lastInsertRowid), email, name: t.name || email, picture: t.picture || '' };
      } else {
        db.prepare('UPDATE users SET google_sub = COALESCE(google_sub, ?), name = ?, picture = ?, updated_at = ? WHERE id = ?')
          .run(t.sub || null, t.name || user.name || email, t.picture || user.picture || '', now, user.id);
        user = db.prepare('SELECT id,email,name,picture FROM users WHERE id = ?').get(user.id);
      }

      createDefaultBotsIfEmpty(user.id);

      const token = randomToken();
      const expires = new Date(Date.now() + 30 * 24 * 3600 * 1000).toISOString();
      db.prepare('INSERT INTO sessions (token,user_id,created_at,expires_at) VALUES (?,?,?,?)').run(token, user.id, now, expires);
      setSessionCookie(res, token);
      return send(res, 200, { ok: true, user });
    } catch (e) {
      return send(res, 401, { error: 'google_verify_failed', details: String(e.message || e) });
    }
  }

  if (req.method === 'GET' && req.url === '/api/auth/me') {
    const user = getUserBySession(req);
    if (!user) return send(res, 401, { ok: false });
    return send(res, 200, { ok: true, user: { id: user.id, email: user.email, name: user.name || '', picture: user.picture || '' } });
  }

  if (req.method === 'POST' && req.url === '/api/auth/logout') {
    const token = parseCookies(req).ocb_session;
    if (token) db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
    clearSessionCookie(res);
    return send(res, 200, { ok: true });
  }

  if (req.method === 'GET' && req.url === '/api/account/bots') {
    const user = getUserBySession(req);
    if (!user) return send(res, 401, { error: 'unauthorized' });
    const bots = db.prepare('SELECT id,name,telegram_username,channel,status,created_at FROM bots WHERE user_id = ? ORDER BY id ASC').all(user.id);
    return send(res, 200, { ok: true, bots });
  }

  if (req.method === 'POST' && req.url === '/api/account/bots') {
    const user = getUserBySession(req);
    if (!user) return send(res, 401, { error: 'unauthorized' });
    const { name, telegram_username } = await readJson(req);
    if (!name) return send(res, 400, { error: 'name_required' });
    const now = nowIso();
    const r = db.prepare('INSERT INTO bots (user_id,name,telegram_username,channel,status,created_at) VALUES (?,?,?,?,?,?)')
      .run(user.id, String(name).trim(), telegram_username || '', 'telegram', 'active', now);
    return send(res, 200, { ok: true, botId: Number(r.lastInsertRowid) });
  }

  send(res, 404, { error: 'not_found' });
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`openclaw-auth-mvp on 127.0.0.1:${PORT} db=${DB_PATH}`);
});
