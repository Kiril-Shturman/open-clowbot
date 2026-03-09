import 'dotenv/config';
import { query } from '../db.js';
import { createYooKassaPayment } from '../services/yookassa.js';

const POLL_MS = Number(process.env.SUBSCRIPTION_WORKER_POLL_MS || 60000);

async function renewOne(sub) {
  try {
    const payment = await createYooKassaPayment({
      amountMinor: Number(sub.amount_minor),
      description: `Продление подписки ${sub.plan_code}`,
      returnUrl: `${process.env.APP_URL}/cabinet`,
      metadata: { userId: sub.user_id, planCode: sub.plan_code, recurring: true, renewal: true, subscriptionId: sub.id },
      savePaymentMethod: true,
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
  } catch (e) {
    await query(`update subscriptions set status = 'past_due', updated_at = now() where id = $1`, [sub.id]);
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
