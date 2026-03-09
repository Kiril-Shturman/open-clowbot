import { Router } from 'express';
import { z } from 'zod';
import { query } from '../db.js';
import { encryptSecret } from '../services/crypto.js';

export const keysRouter = Router();

const upsertSchema = z.object({
  userId: z.string().uuid(),
  provider: z.enum(['openrouter', 'telegram', 'hostkey', 'yookassa']),
  keyName: z.string().min(1),
  secretValue: z.string().min(1),
});

keysRouter.post('/upsert', async (req, res) => {
  const parsed = upsertSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  const { userId, provider, keyName, secretValue } = parsed.data;
  const encrypted = encryptSecret(secretValue);

  await query(
    `insert into secrets (user_id, provider, key_name, secret_enc)
     values ($1, $2, $3, $4)
     on conflict (user_id, provider, key_name)
     do update set secret_enc = excluded.secret_enc, updated_at = now()`,
    [userId, provider, keyName, encrypted],
  );

  await query(
    `insert into audit_logs (user_id, action, target, metadata)
     values ($1, 'secret_upsert', $2, $3::jsonb)`,
    [userId, `${provider}:${keyName}`, JSON.stringify({ provider, keyName })],
  );

  res.json({ ok: true });
});

keysRouter.get('/:userId', async (req, res) => {
  const rows = await query(
    `select id, provider, key_name, created_at, updated_at
     from secrets where user_id = $1 order by updated_at desc`,
    [req.params.userId],
  );
  res.json({ keys: rows.rows });
});
