import { Router } from 'express';
import { z } from 'zod';
import { query } from '../db.js';

export const billingRouter = Router();

billingRouter.get('/wallet/:userId', async (req, res) => {
  const { userId } = req.params;
  const result = await query(
    `select user_id, balance_minor, currency, updated_at from wallets where user_id = $1`,
    [userId],
  );
  if (!result.rows.length) return res.status(404).json({ error: 'wallet_not_found' });
  res.json(result.rows[0]);
});

const adjustSchema = z.object({
  userId: z.string().uuid(),
  deltaMinor: z.number().int(),
  reason: z.string().min(1),
});

billingRouter.post('/ledger/adjust', async (req, res) => {
  const parsed = adjustSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  const { userId, deltaMinor, reason } = parsed.data;
  await query('begin');
  try {
    await query(
      `insert into wallets (user_id, balance_minor, currency)
       values ($1, 0, 'RUB')
       on conflict (user_id) do nothing`,
      [userId],
    );

    await query(`update wallets set balance_minor = balance_minor + $1, updated_at = now() where user_id = $2`, [
      deltaMinor,
      userId,
    ]);

    await query(
      `insert into ledger_entries (user_id, delta_minor, currency, reason, metadata)
       values ($1, $2, 'RUB', $3, '{}'::jsonb)`,
      [userId, deltaMinor, reason],
    );
    await query('commit');
    res.json({ ok: true });
  } catch (error) {
    await query('rollback');
    res.status(500).json({ error: String(error.message || error) });
  }
});
