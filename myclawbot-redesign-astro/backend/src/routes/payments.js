import { Router } from 'express';
import { z } from 'zod';
import crypto from 'crypto';
import { query } from '../db.js';
import { createYooKassaPayment, verifyYooKassaWebhookSecret } from '../services/yookassa.js';

export const paymentsRouter = Router();

const createPaymentSchema = z.object({
  userId: z.string().uuid(),
  amountRub: z.number().positive(),
  planCode: z.string().min(1),
  recurring: z.boolean().default(false),
  description: z.string().min(1).default('Подписка MyClawBot'),
});

const ALLOWED_STATUSES = new Set(['pending', 'waiting_for_capture', 'succeeded', 'canceled']);

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
  if (!verifyYooKassaWebhookSecret(req)) {
    return res.status(401).json({ error: 'invalid_webhook_secret' });
  }

  const body = req.body || {};
  const eventType = body?.event || 'unknown';
  const object = body?.object || {};

  if (!object?.id || !object?.status || !ALLOWED_STATUSES.has(object.status)) {
    return res.status(400).json({ error: 'invalid_payload' });
  }

  const eventHash = crypto.createHash('sha256').update(JSON.stringify(body)).digest('hex');

  try {
    await query(
      `insert into payment_events (provider, event_type, provider_payment_id, payload, event_hash)
       values ('yookassa', $1, $2, $3::jsonb, $4)`,
      [eventType, object.id, JSON.stringify(body), eventHash],
    );
  } catch (e) {
    if (String(e.message || e).includes('duplicate key')) return res.json({ ok: true, duplicate: true });
    return res.status(500).json({ error: String(e.message || e) });
  }

  const paymentRow = await query(
    `select id, user_id, amount_minor, status, metadata from payments where provider_payment_id = $1 limit 1`,
    [object.id],
  );
  const row = paymentRow.rows[0];
  if (!row) return res.json({ ok: true, ignored: 'payment_not_found' });

  const prevStatus = row.status;
  const nextStatus = object.status;

  // terminal states should not be moved backwards
  if ((prevStatus === 'succeeded' || prevStatus === 'canceled') && prevStatus !== nextStatus) {
    return res.json({ ok: true, ignored: 'terminal_state' });
  }

  await query(`update payments set status = $1, updated_at = now() where provider_payment_id = $2`, [nextStatus, object.id]);

  if (eventType === 'payment.succeeded' && prevStatus !== 'succeeded') {
    const recurring = Boolean(row.metadata?.recurring);
    const planCode = row.metadata?.planCode || 'default';
    const paymentMethodId = object.payment_method?.id || row.metadata?.payment_method_id || null;

    await query('begin');
    try {
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
           do update set status = 'active', amount_minor = excluded.amount_minor, updated_at = now(), current_period_start = now(), current_period_end = now() + interval '1 month'`,
          [row.user_id, paymentMethodId, planCode, row.amount_minor, paymentMethodId],
        );
      }

      await query('commit');
    } catch (e) {
      await query('rollback');
      return res.status(500).json({ error: String(e.message || e) });
    }
  }

  if ((eventType === 'payment.canceled' || nextStatus === 'canceled') && row.metadata?.subscriptionId) {
    await query(
      `update subscriptions set status = 'past_due', updated_at = now() where id = $1 and status <> 'canceled'`,
      [row.metadata.subscriptionId],
    );
  }

  res.json({ ok: true });
});
