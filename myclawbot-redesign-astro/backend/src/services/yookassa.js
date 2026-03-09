import crypto from 'crypto';

function getAuthHeader() {
  const shopId = process.env.YOOKASSA_SHOP_ID;
  const secret = process.env.YOOKASSA_SECRET_KEY;
  if (!shopId || !secret) throw new Error('YOOKASSA_SHOP_ID / YOOKASSA_SECRET_KEY is required');
  const token = Buffer.from(`${shopId}:${secret}`).toString('base64');
  return `Basic ${token}`;
}

function getBaseHeaders(idempotenceKey) {
  return {
    Authorization: getAuthHeader(),
    'Content-Type': 'application/json',
    'Idempotence-Key': idempotenceKey,
  };
}

export function verifyYooKassaWebhookSecret(req) {
  const expected = process.env.YOOKASSA_WEBHOOK_SECRET;
  if (!expected) return true; // allow local development

  const provided = req.header('x-yookassa-webhook-secret') || req.header('x-yookassa-secret');
  if (!provided) return false;

  const a = Buffer.from(expected);
  const b = Buffer.from(provided);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

export async function createYooKassaPayment({ amountMinor, description, returnUrl, metadata = {}, savePaymentMethod = false }) {
  const idempotenceKey = crypto.randomUUID();
  const amount = (amountMinor / 100).toFixed(2);

  const body = {
    amount: { value: amount, currency: 'RUB' },
    confirmation: { type: 'redirect', return_url: returnUrl },
    capture: true,
    description,
    metadata,
    save_payment_method: savePaymentMethod,
  };

  const response = await fetch('https://api.yookassa.ru/v3/payments', {
    method: 'POST',
    headers: getBaseHeaders(idempotenceKey),
    body: JSON.stringify(body),
  });

  const payload = await response.json();
  if (!response.ok) {
    throw new Error(`YooKassa create payment failed: ${response.status} ${JSON.stringify(payload)}`);
  }

  return payload;
}

export async function createYooKassaRecurringCharge({ amountMinor, description, paymentMethodId, metadata = {} }) {
  const idempotenceKey = crypto.randomUUID();
  const amount = (amountMinor / 100).toFixed(2);

  const body = {
    amount: { value: amount, currency: 'RUB' },
    capture: true,
    description,
    payment_method_id: paymentMethodId,
    metadata,
  };

  const response = await fetch('https://api.yookassa.ru/v3/payments', {
    method: 'POST',
    headers: getBaseHeaders(idempotenceKey),
    body: JSON.stringify(body),
  });

  const payload = await response.json();
  if (!response.ok) {
    throw new Error(`YooKassa recurring charge failed: ${response.status} ${JSON.stringify(payload)}`);
  }

  return payload;
}
