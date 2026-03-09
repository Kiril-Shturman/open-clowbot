import crypto from 'crypto';
import { Router } from 'express';
import jwt from 'jsonwebtoken';
import { query } from '../db.js';
import { requireAuth } from '../middleware/auth.js';

const authRouter = Router();

const JWT_SECRET = process.env.JWT_SECRET || '';
const COOKIE_NAME = process.env.AUTH_COOKIE_NAME || 'myclawbot_auth';
const APP_URL = process.env.APP_URL || 'http://localhost:4321';
const isProd = process.env.NODE_ENV === 'production';

function signJwt(user) {
  if (!JWT_SECRET) throw new Error('JWT_SECRET_not_configured');
  return jwt.sign({ sub: user.id, role: user.role || 'user' }, JWT_SECRET, { expiresIn: '30d' });
}

function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  const derived = crypto.scryptSync(password, salt, 64).toString('hex');
  return `${salt}:${derived}`;
}

function verifyPassword(password, passwordHash) {
  if (!passwordHash || !passwordHash.includes(':')) return false;
  const [salt, original] = passwordHash.split(':');
  const derived = crypto.scryptSync(password, salt, 64).toString('hex');
  return crypto.timingSafeEqual(Buffer.from(original, 'hex'), Buffer.from(derived, 'hex'));
}

function setAuthCookie(res, token) {
  res.cookie(COOKIE_NAME, token, {
    httpOnly: true,
    secure: isProd,
    sameSite: 'lax',
    path: '/',
    maxAge: 30 * 24 * 60 * 60 * 1000,
  });
}

function clearAuthCookie(res) {
  res.clearCookie(COOKIE_NAME, {
    httpOnly: true,
    secure: isProd,
    sameSite: 'lax',
    path: '/',
  });
}

async function ensureWallet(userId) {
  await query(
    `insert into wallets (user_id, balance_minor, currency)
     values ($1, 0, 'RUB')
     on conflict (user_id) do nothing`,
    [userId]
  );
}

authRouter.post('/register', async (req, res, next) => {
  try {
    const name = String(req.body?.name || '').trim();
    const email = String(req.body?.email || '').trim().toLowerCase();
    const password = String(req.body?.password || '');

    if (!email || !password) return res.status(400).json({ error: 'email_and_password_required' });
    if (password.length < 6) return res.status(400).json({ error: 'password_too_short' });

    const existing = await query(`select id from users where email = $1 limit 1`, [email]);
    if (existing.rows[0]) return res.status(409).json({ error: 'email_already_exists' });

    const passwordHash = hashPassword(password);
    const result = await query(
      `insert into users (email, name, role, password_hash)
       values ($1, $2, 'user', $3)
       returning id, email, name, role`,
      [email, name || null, passwordHash]
    );

    const user = result.rows[0];
    await ensureWallet(user.id);

    const token = signJwt(user);
    setAuthCookie(res, token);
    res.status(201).json({ ok: true, user, token });
  } catch (error) {
    next(error);
  }
});

authRouter.post('/login', async (req, res, next) => {
  try {
    const email = String(req.body?.email || '').trim().toLowerCase();
    const password = String(req.body?.password || '');
    if (!email || !password) return res.status(400).json({ error: 'email_and_password_required' });

    const result = await query(
      `select id, email, name, role, password_hash
       from users
       where email = $1
       limit 1`,
      [email]
    );

    const user = result.rows[0];
    if (!user?.password_hash || !verifyPassword(password, user.password_hash)) {
      return res.status(401).json({ error: 'invalid_credentials' });
    }

    await ensureWallet(user.id);
    const token = signJwt(user);
    setAuthCookie(res, token);
    res.json({ ok: true, token, user: { id: user.id, email: user.email, name: user.name, role: user.role } });
  } catch (error) {
    next(error);
  }
});

authRouter.post('/google', async (req, res, next) => {
  try {
    const credential = String(req.body?.credential || '');
    if (!credential) return res.status(400).json({ error: 'credential_required' });

    const verifyUrl = new URL('https://oauth2.googleapis.com/tokeninfo');
    verifyUrl.searchParams.set('id_token', credential);
    const verifyRes = await fetch(verifyUrl);
    const payload = await verifyRes.json();

    if (!verifyRes.ok || !payload?.email) {
      return res.status(401).json({ error: 'invalid_google_token', detail: payload?.error_description || payload?.error || null });
    }

    const email = String(payload.email).trim().toLowerCase();
    const name = String(payload.name || payload.given_name || '').trim() || null;

    let userRes = await query(
      `select id, email, name, role from users where email = $1 limit 1`,
      [email]
    );

    let user = userRes.rows[0];

    if (!user) {
      const created = await query(
        `insert into users (email, name, role)
         values ($1, $2, 'user')
         returning id, email, name, role`,
        [email, name]
      );
      user = created.rows[0];
    }

    await ensureWallet(user.id);
    const token = signJwt(user);
    setAuthCookie(res, token);
    res.json({ ok: true, token, user });
  } catch (error) {
    next(error);
  }
});

authRouter.get('/me', requireAuth, async (req, res, next) => {
  try {
    const userId = req.auth.userId;
    const userRes = await query(`select id, email, name, role from users where id = $1 limit 1`, [userId]);
    const walletRes = await query(`select balance_minor, currency from wallets where user_id = $1 limit 1`, [userId]);
    const subRes = await query(
      `select id, plan_code, status, current_period_end
       from subscriptions
       where user_id = $1
       order by created_at desc
       limit 1`,
      [userId]
    );

    const user = userRes.rows[0];
    if (!user) return res.status(404).json({ ok: false, error: 'user_not_found' });

    const wallet = walletRes.rows[0] || { balance_minor: 0, currency: 'RUB' };
    const subscription = subRes.rows[0] || null;
    const activeStatuses = new Set(['active', 'trialing', 'past_due']);

    res.json({
      ok: true,
      user,
      wallet_balance: Number(wallet.balance_minor || 0) / 100,
      wallet_balance_minor: Number(wallet.balance_minor || 0),
      wallet_currency: wallet.currency || 'RUB',
      subscription,
      subscription_active: subscription ? activeStatuses.has(subscription.status) : false,
    });
  } catch (error) {
    next(error);
  }
});

authRouter.post('/logout', (_req, res) => {
  clearAuthCookie(res);
  res.json({ ok: true });
});

authRouter.get('/health', (_req, res) => {
  res.json({ ok: true, appUrl: APP_URL, cookieName: COOKIE_NAME });
});

export { authRouter };
