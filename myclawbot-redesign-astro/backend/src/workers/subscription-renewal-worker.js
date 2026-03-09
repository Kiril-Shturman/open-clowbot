import 'dotenv/config';
import { query } from '../db.js';
import { createYooKassaRecurringCharge } from '../services/yookassa.js';

const POLL_MS = Number(process.env.SUBSCRIPTION_WORKER_POLL_MS || 60000);
const MAX_PAST_DUE_CYCLES = Number(process.env.SUBSCRIPTION_MAX_PAST_DUE_CYCLES || 3);

async function renewOne(sub) {
  try {
    if (!sub.yookassa_payment_method_id) throw new Error('no payment method id');

    const payment = await createYooKassaRecurringCharge({
      amountMinor: Number(sub.amount_minor),
      description: `Продление подписки ${sub.plan_code}`,
      paymentMethodId: sub.yookassa_payment_method_id,
      metadata: { userId: sub.user_id, planCode: sub.plan_code, recurring: true, renewal: true, subscriptionId: sub.id },
    });

    await query(
      `insert into payments (user_id, provider, provider_payment_id, amount_minor, currency, status, metadata)
       values ($1, 'yookassa', $2, $3, $4, $5, $6::jsonb)`,
      [
        sub.user_id,
        payment.id,
        sub.amount_minor,
        sub.currency,
        payment.status || 'pending',
        JSON.stringify({ planCode: sub.plan_code, recurring: true, renewal: true, subscriptionId: sub.id }),
      ],
    );

    await query(`update subscriptions set status = 'pending_renewal', updated_at = now() where id = $1`, [sub.id]);
  } catch (_e) {
    const pastDueCount = Number(sub.metadata?.past_due_count || 0) + 1;
    const nextStatus = pastDueCount >= MAX_PAST_DUE_CYCLES ? 'canceled' : 'past_due';

    await query(
      `update subscriptions
       set status = $2,
           canceled_at = case when $2 = 'canceled' then now() else canceled_at end,
           metadata = coalesce(metadata, '{}'::jsonb) || jsonb_build_object('past_due_count', $3),
           updated_at = now()
       where id = $1`,
      [sub.id, nextStatus, pastDueCount],
    );
  }
}

async function tick() {
  const due = await query(
    `select * from subscriptions
     where status in ('active','past_due')
       and current_period_end is not null
       and current_period_end <= now()`,
  );

  for (const sub of due.rows) {
    // eslint-disable-next-line no-await-in-loop
    await renewOne(sub);
  }
}

async function loop() {
  while (true) {
    await tick();
    await new Promise((r) => setTimeout(r, POLL_MS));
  }
}

console.log('Subscription renewal worker started');
loop();
