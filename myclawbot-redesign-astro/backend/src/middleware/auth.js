import jwt from 'jsonwebtoken';

const JWT_SECRET = process.env.JWT_SECRET || '';

const PUBLIC_API_PATHS = new Set(['/payments/webhook/yookassa']);

export function requireAuth(req, res, next) {
  if (PUBLIC_API_PATHS.has(req.path)) return next();

  if (!JWT_SECRET) {
    return res.status(500).json({ error: 'JWT_SECRET_not_configured' });
  }

  const auth = req.headers.authorization || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'unauthorized' });

  try {
    const payload = jwt.verify(token, JWT_SECRET);
    req.auth = {
      userId: payload.sub,
      role: payload.role || 'user',
    };
    return next();
  } catch {
    return res.status(401).json({ error: 'invalid_token' });
  }
}

export function enforceUserScope(req, res, next) {
  const authUserId = req.auth?.userId;
  const role = req.auth?.role;
  const scopedUserId = req.params.userId || req.body?.userId || req.query?.userId;

  if (role === 'admin') return next();
  if (!authUserId || !scopedUserId || authUserId !== scopedUserId) {
    return res.status(403).json({ error: 'forbidden' });
  }
  return next();
}
