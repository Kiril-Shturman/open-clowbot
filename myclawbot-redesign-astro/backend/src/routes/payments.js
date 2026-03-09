import { Router } from 'express';
import { z } from 'zod';
import crypto from 'crypto';
import { pool, query } from '../db.js';
import { createYooKassaPayment, verifyYooKassaWebhookSecret } from '../services/yookassa.js';
import { enforceUserScope } from '../middleware/auth.js';

export const paymentsRouter = Router();

const createPaymentSchema = z.object({
  userId: z.string().uuid(),
  amountRub: z.number().positive(),
  planCode: z.string().min(1),
  recurring: z.boolean().default(false),
  description: z.string().min(1).default('Подписка MyClawBot'),
});

const ALLOWED_STATUSES = new Set(['pending', 'waiting_for_capture', 'succeeded', 'canceled']);
const TERMINAL_STATUSES = new Set(['succeeded', 'canceled', 'refunded', 'charged_back', 'failed']);

function mapIncomingStatus(eventType, object) {
  const type = String(eventType || '').toLowerCase();
  const status = String(object?.status || '').toLowerCase();

  if (type.includes('refund') || type.includes('payment.refunded')) return 'refunded';
  if (type.includes('chargeback') || type.includes('dispute')) return 'charged_back';
  if (type.includes('failed')) return 'failed';

  if (ALLOWED_STATUSES.has(status)) return status;
  if (!status && type.includes('canceled')) return 'canceled';

  return null;
}

function canTransition(prev, next) {
  if (!prev || prev === next) return true;

  const transitions = {
    pending: new Set(['waiting_for_capture', 'succeeded', 'canceled', 'failed']),
    waiting_for_capture: new Set(['succeeded', 'canceled', 'failed']),
    succeeded: new Set(['refunded', 'charged_back']),
    canceled: new Set(),
    failed: new Set(),
    refunded: new Set(),
    charged_back: new Set(),
  };

  if (TERMINAL_STATUSES.has(prev) && prev !== next) {
    return transitions[prev]?.has(next) || false;
  }

  return transitions[prev]?.has(next) || false;
}

async function withTx(fn) {
  const client = await pool.connect();
  try {
    await client.query('begin');
    const result = await fn(client);
    await client.query('commit');
    return result;
  } catch (error) {
    await client.query('rollback');
    throw error;
  } finally {
    client.release();
  }
}

paymentsRouter.post('/create', enforceUserScope, async (req, res) => {
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

paymentsRouter.get('/history/:userId', enforceUserScope, async (req, res) => {
  const rows = await query(
    `select id, provider, provider_payment_id, amount_minor, currency, status, metadata, created_at, updated_at
     from payments
     where user_id = $1
     order by created_at desc
     limit 50`,
    [req.params.userId],
  );
  res.json({ payments: rows.rows });
});

paymentsRouter.post('/webhook/yookassa', async (req, res) => {
  if (!verifyYooKassaWebhookSecret(req)) {
    return res.status(401).json({ error: 'invalid_webhook_secret' });
  }

  const body = req.body || {};
  const eventType = body?.event || 'unknown';
  const object = body?.object || {};

  const providerPaymentId = object?.id || object?.payment_id;
  const nextStatus = mapIncomingStatus(eventType, object);

  if (!providerPaymentId || !nextStatus) {
    return res.status(400).json({ error: 'invalid_payload' });
  }

  const eventHash = crypto.createHash('sha256').update(JSON.stringify(body)).digest('hex');

  try {
    await query(
      `insert into payment_events (provider, event_type, provider_payment_id, payload, event_hash)
       values ('yookassa', $1, $2, $3::jsonb, $4)`,
      [eventType, providerPaymentId, JSON.stringify(body), eventHash],
    );
  } catch (e) {
    if (String(e.message || e).includes('duplicate key')) return res.json({ ok: true, duplicate: true });
    return res.status(500).json({ error: String(e.message || e) });
  }

  const paymentRow = await query(
    `select id, user_id, amount_minor, status, metadata from payments where provider_payment_id = $1 limit 1`,
    [providerPaymentId],
  );
  const row = paymentRow.rows[0];
  if (!row) return res.json({ ok: true, ignored: 'payment_not_found' });

  const prevStatus = row.status;
  if (!canTransition(prevStatus, nextStatus)) {
    return res.json({ ok: true, ignored: 'invalid_state_transition', prevStatus, nextStatus });
  }

  await query(`update payments set status = $1, updated_at = now() where provider_payment_id = $2`, [nextStatus, providerPaymentId]);

  if (eventType === 'payment.succeeded' && prevStatus !== 'succeeded') {
    const recurring = Boolean(row.metadata?.recurring);
    const planCode = row.metadata?.planCode || 'default';
    const paymentMethodId = object.payment_method?.id || row.metadata?.payment_method_id || null;

    try {
      await withTx(async (client) => {
        await client.query(
          `insert into wallets (user_id, balance_minor, currency) values ($1, 0, 'RUB')
           on conflict (user_id) do nothing`,
          [row.user_id],
        );
        await client.query(`update wallets set balance_minor = balance_minor + $1, updated_at = now() where user_id = $2`, [
          row.amount_minor,
          row.user_id,
        ]);
        await client.query(
          `insert into ledger_entries (user_id, delta_minor, currency, reason, metadata)
           values ($1, $2, 'RUB', 'yookassa_topup', $3::jsonb)`,
          [row.user_id, row.amount_minor, JSON.stringify({ providerPaymentId })],
        );

        if (recurring && paymentMethodId) {
          await client.query(
            `insert into subscriptions (user_id, provider, provider_subscription_id, plan_code, status, amount_minor, currency, yookassa_payment_method_id, current_period_start, current_period_end, metadata)
             values ($1, 'yookassa', $2, $3, 'active', $4, 'RUB', $5, now(), now() + interval '1 month', '{}'::jsonb)
             on conflict (provider_subscription_id)
             do update set status = 'active', amount_minor = excluded.amount_minor, updated_at = now(), current_period_start = now(), current_period_end = now() + interval '1 month', yookassa_payment_method_id = excluded.yookassa_payment_method_id`,
            [row.user_id, paymentMethodId, planCode, row.amount_minor, paymentMethodId],
          );
        }
      });
    } catch (e) {
      return res.status(500).json({ error: String(e.message || e) });
    }
  }

  const linkedSubscriptionId = row.metadata?.subscriptionId || null;

  if (linkedSubscriptionId && (nextStatus === 'failed' || nextStatus === 'canceled')) {
    await query(
      `update subscriptions
       set status = 'past_due',
           metadata = coalesce(metadata, '{}'::jsonb) || jsonb_build_object('last_payment_failure_at', now(), 'last_payment_status', $2),
           updated_at = now()
       where id = $1 and status not in ('canceled')`,
      [linkedSubscriptionId, nextStatus],
    );
  }

  if (linkedSubscriptionId && (nextStatus === 'refunded' || nextStatus === 'charged_back')) {
    await query(
      `update subscriptions
       set status = 'canceled',
           canceled_at = now(),
           metadata = coalesce(metadata, '{}'::jsonb) || jsonb_build_object('cancellation_reason', $2, 'cancellation_at', now()),
           updated_at = now()
       where id = $1 and status <> 'canceled'`,
      [linkedSubscriptionId, nextStatus],
    );
  }

  res.json({ ok: true });
});
