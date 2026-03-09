import { Router } from 'express';
import { z } from 'zod';
import { query } from '../db.js';

export const subscriptionsRouter = Router();

subscriptionsRouter.get('/:userId', async (req, res) => {
  const rows = await query(
    `select * from subscriptions where user_id = $1 order by created_at desc`,
    [req.params.userId],
  );
  res.json({ subscriptions: rows.rows });
});

const cancelSchema = z.object({
  userId: z.string().uuid(),
  subscriptionId: z.string().uuid(),
});

subscriptionsRouter.post('/cancel', async (req, res) => {
  const parsed = cancelSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  const { userId, subscriptionId } = parsed.data;
  const result = await query(
    `update subscriptions
     set status = 'canceled', canceled_at = now(), updated_at = now()
     where id = $1 and user_id = $2
     returning id, status`,
    [subscriptionId, userId],
  );

  if (!result.rows.length) return res.status(404).json({ error: 'subscription_not_found' });
  res.json({ ok: true, subscription: result.rows[0] });
});
