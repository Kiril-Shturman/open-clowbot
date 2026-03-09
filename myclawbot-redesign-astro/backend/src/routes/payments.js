import { Router } from 'express';
import { z } from 'zod';
import crypto from 'crypto';
import { query } from '../db.js';
import { createYooKassaPayment } from '../services/yookassa.js';

export const paymentsRouter = Router();

const createPaymentSchema = z.object({
  userId: z.string().uuid(),
  amountRub: z.number().positive(),
  planCode: z.string().min(1),
  recurring: z.boolean().default(false),
  description: z.string().min(1).default('Подписка MyClawBot'),
});

paymentsRouter.post('/create', async (req, res) => {
  const parsed = createPaymentSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  const { userId, amountRub, planCode, recurring, description } = parsed.data;
  const amountMinor = Math.round(amountRub * 100);

  try {
    const payment = await createYooKassaPayment({
      amountMinor,
      description,
      returnUrl: `${process.env.APP_URL}/cabinet`,
      metadata: { userId, planCode, recurring },
      savePaymentMethod: recurring,
    });

    const inserted = await query(
      `insert into payments (user_id, provider, provider_payment_id, amount_minor, currency, status, metadata)
       values ($1, 'yookassa', $2, $3, 'RUB', $4, $5::jsonb)
       returning id`,
      [userId, payment.id, amountMinor, payment.status || 'pending', JSON.stringify({ planCode, recurring, yk: payment })],
    );

    res.json({
      paymentId: inserted.rows[0].id,
      providerPaymentId: payment.id,
      confirmationUrl: payment.confirmation?.confirmation_url || null,
      status: payment.status,
    });
  } catch (error) {
    res.status(500).json({ error: String(error.message || error) });
  }
});

paymentsRouter.post('/webhook/yookassa', async (req, res) => {
  const body = req.body || {};
  const eventType = body?.event || 'unknown';
  const object = body?.object || {};
  const eventHash = crypto.createHash('sha256').update(JSON.stringify(body)).digest('hex');

  try {
    await query(
      `insert into payment_events (provider, event_type, provider_payment_id, payload, event_hash)
       values ('yookassa', $1, $2, $3::jsonb, $4)`,
      [eventType, object.id || null, JSON.stringify(body), eventHash],
    );
  } catch (e) {
    // duplicate event -> idempotent ack
    if (String(e.message || e).includes('duplicate key')) return res.json({ ok: true, duplicate: true });
    return res.status(500).json({ error: String(e.message || e) });
  }

  if (object.id && object.status) {
    await query(`update payments set status = $1, updated_at = now() where provider_payment_id = $2`, [
      object.status,
      object.id,
    ]);

    if (eventType === 'payment.succeeded') {
      const paymentRow = await query(
        `select user_id, amount_minor, metadata from payments where provider_payment_id = $1 limit 1`,
        [object.id],
      );
      const row = paymentRow.rows[0];
      if (row) {
        const recurring = Boolean(row.metadata?.recurring);
        const planCode = row.metadata?.planCode || 'default';
        const paymentMethodId = object.payment_method?.id || null;

        await query('begin');
        await query(
          `insert into wallets (user_id, balance_minor, currency) values ($1, 0, 'RUB')
           on conflict (user_id) do nothing`,
          [row.user_id],
        );
        await query(`update wallets set balance_minor = balance_minor + $1, updated_at = now() where user_id = $2`, [
          row.amount_minor,
          row.user_id,
        ]);
        await query(
          `insert into ledger_entries (user_id, delta_minor, currency, reason, metadata)
           values ($1, $2, 'RUB', 'yookassa_topup', $3::jsonb)`,
          [row.user_id, row.amount_minor, JSON.stringify({ providerPaymentId: object.id })],
        );

        if (recurring && paymentMethodId) {
          await query(
            `insert into subscriptions (user_id, provider, provider_subscription_id, plan_code, status, amount_minor, currency, yookassa_payment_method_id, current_period_start, current_period_end)
             values ($1, 'yookassa', $2, $3, 'active', $4, 'RUB', $5, now(), now() + interval '1 month')
             on conflict (provider_subscription_id)
             do update set status = 'active', updated_at = now(), current_period_start = now(), current_period_end = now() + interval '1 month'`,
            [row.user_id, paymentMethodId, planCode, row.amount_minor, paymentMethodId],
          );
        }

        await query('commit');
      }
    }
  }

  res.json({ ok: true });
});
