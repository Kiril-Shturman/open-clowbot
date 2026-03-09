import { Router } from 'express';
import { z } from 'zod';
import { query } from '../db.js';

export const paymentsRouter = Router();

const createPaymentSchema = z.object({
  userId: z.string().uuid(),
  amountRub: z.number().positive(),
  planCode: z.string().min(1),
  recurring: z.boolean().default(false),
});

paymentsRouter.post('/create', async (req, res) => {
  const parsed = createPaymentSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  const { userId, amountRub, planCode, recurring } = parsed.data;

  // TODO: call real YooKassa API.
  const providerPaymentId = `yk_${Date.now()}`;
  const confirmationUrl = `${process.env.APP_URL}/payment/success?payment=${providerPaymentId}`;

  const inserted = await query(
    `insert into payments (user_id, provider, provider_payment_id, amount_minor, currency, status, metadata)
     values ($1, 'yookassa', $2, $3, 'RUB', 'pending', $4::jsonb)
     returning id`,
    [userId, providerPaymentId, Math.round(amountRub * 100), JSON.stringify({ planCode, recurring })],
  );

  res.json({
    paymentId: inserted.rows[0].id,
    providerPaymentId,
    confirmationUrl,
  });
});

paymentsRouter.post('/webhook/yookassa', async (req, res) => {
  // TODO: verify signature from YooKassa webhook headers using YOOKASSA_WEBHOOK_SECRET.
  const body = req.body;
  const eventType = body?.event || 'unknown';
  const object = body?.object || {};

  await query(
    `insert into payment_events (provider, event_type, provider_payment_id, payload)
     values ('yookassa', $1, $2, $3::jsonb)`,
    [eventType, object.id || null, JSON.stringify(body || {})],
  );

  if (object.id && object.status) {
    await query(`update payments set status = $1, updated_at = now() where provider_payment_id = $2`, [
      object.status,
      object.id,
    ]);
  }

  res.json({ ok: true });
});
