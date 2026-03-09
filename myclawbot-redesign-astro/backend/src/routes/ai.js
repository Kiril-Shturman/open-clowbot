import { Router } from 'express';
import { z } from 'zod';
import { withTransaction, query } from '../db.js';
import { openRouterChat } from '../services/openrouter.js';
import { calcCostMinor, getModelPricing, getPreHoldMinor, getDailySpendLimitMinor } from '../services/pricing.js';

export const aiRouter = Router();

const chatSchema = z.object({
  userId: z.string().uuid(),
  model: z.string().min(1),
  messages: z.array(z.object({ role: z.string(), content: z.string() })).min(1),
});

const RATE_WINDOW_MS = Number(process.env.AI_RATE_LIMIT_WINDOW_MS || 60_000);
const RATE_MAX_PER_USER = Number(process.env.AI_RATE_LIMIT_PER_USER || 20);
const RATE_MAX_PER_IP = Number(process.env.AI_RATE_LIMIT_PER_IP || 60);

const rateBuckets = new Map();

function rateKey(prefix, key) {
  return `${prefix}:${key || 'unknown'}`;
}

function hitRateLimit(key, max) {
  const now = Date.now();
  const bucket = rateBuckets.get(key) || [];
  const fresh = bucket.filter((ts) => now - ts < RATE_WINDOW_MS);
  fresh.push(now);
  rateBuckets.set(key, fresh);
  return fresh.length > max;
}

function cleanupRateBuckets() {
  const now = Date.now();
  for (const [k, arr] of rateBuckets.entries()) {
    const fresh = arr.filter((ts) => now - ts < RATE_WINDOW_MS);
    if (fresh.length) rateBuckets.set(k, fresh);
    else rateBuckets.delete(k);
  }
}

setInterval(cleanupRateBuckets, RATE_WINDOW_MS).unref();

aiRouter.post('/chat', async (req, res) => {
  const parsed = chatSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  const { userId, model, messages } = parsed.data;
  const preHoldMinor = getPreHoldMinor();
  const dailyLimitMinor = getDailySpendLimitMinor();
  const ip = req.ip || req.headers['x-forwarded-for'] || 'unknown';

  if (hitRateLimit(rateKey('user', userId), RATE_MAX_PER_USER)) {
    return res.status(429).json({ error: 'rate_limited_user' });
  }
  if (hitRateLimit(rateKey('ip', String(ip)), RATE_MAX_PER_IP)) {
    return res.status(429).json({ error: 'rate_limited_ip' });
  }

  try {
    await withTransaction(async (client) => {
      await client.query(
        `insert into wallets (user_id, balance_minor, currency) values ($1, 0, 'RUB')
         on conflict (user_id) do nothing`,
        [userId],
      );

      const spentToday = await client.query(
        `select coalesce(sum(cost_minor),0)::bigint as spent_minor
         from usage_logs
         where user_id = $1 and created_at::date = now()::date`,
        [userId],
      );
      const spentTodayMinor = Number(spentToday.rows[0]?.spent_minor || 0);

      if (spentTodayMinor + preHoldMinor > dailyLimitMinor) {
        throw new Error('daily_limit_exceeded');
      }

      const wallet = await client.query(`select balance_minor from wallets where user_id = $1 for update`, [userId]);
      const balance = Number(wallet.rows[0]?.balance_minor || 0);

      if (balance < preHoldMinor) {
        throw new Error(`insufficient_balance:${balance}`);
      }

      await client.query(`update wallets set balance_minor = balance_minor - $1, updated_at = now() where user_id = $2`, [
        preHoldMinor,
        userId,
      ]);
      await client.query(
        `insert into ledger_entries (user_id, delta_minor, currency, reason, metadata)
         values ($1, $2, 'RUB', 'openrouter_prehold', $3::jsonb)`,
        [userId, -preHoldMinor, JSON.stringify({ model })],
      );
    });
  } catch (e) {
    const msg = String(e.message || e);
    if (msg === 'daily_limit_exceeded') {
      return res.status(429).json({ error: 'daily_limit_exceeded', dailyLimitMinor });
    }
    if (msg.startsWith('insufficient_balance:')) {
      const balanceMinor = Number(msg.split(':')[1] || 0);
      return res.status(402).json({ error: 'insufficient_balance', requiredMinor: preHoldMinor, balanceMinor });
    }
    return res.status(500).json({ error: msg });
  }

  try {
    const startedAt = Date.now();
    const response = await openRouterChat({ model, messages });
    const elapsedMs = Date.now() - startedAt;

    const usage = response.usage || {};
    const promptTokens = Number(usage.prompt_tokens || 0);
    const completionTokens = Number(usage.completion_tokens || 0);
    const totalTokens = Number(usage.total_tokens || promptTokens + completionTokens);

    const pricing = await getModelPricing(model);
    const realCostMinor = calcCostMinor({
      promptTokens,
      completionTokens,
      inputUsdPerMTok: pricing.input_usd_per_mtok,
      outputUsdPerMTok: pricing.output_usd_per_mtok,
    });

    const settlementDeltaMinor = preHoldMinor - realCostMinor;

    await withTransaction(async (client) => {
      if (settlementDeltaMinor !== 0) {
        await client.query(`update wallets set balance_minor = balance_minor + $1, updated_at = now() where user_id = $2`, [
          settlementDeltaMinor,
          userId,
        ]);
        await client.query(
          `insert into ledger_entries (user_id, delta_minor, currency, reason, metadata)
           values ($1, $2, 'RUB', 'openrouter_settlement', $3::jsonb)`,
          [userId, settlementDeltaMinor, JSON.stringify({ model, realCostMinor, preHoldMinor })],
        );
      }

      await client.query(
        `insert into usage_logs (user_id, model, prompt_tokens, completion_tokens, total_tokens, cost_minor, prehold_minor, settlement_delta_minor, latency_ms, raw_response)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb)`,
        [
          userId,
          model,
          promptTokens,
          completionTokens,
          totalTokens,
          realCostMinor,
          preHoldMinor,
          settlementDeltaMinor,
          elapsedMs,
          JSON.stringify(response),
        ],
      );
    });

    return res.json(response);
  } catch (error) {
    await withTransaction(async (client) => {
      await client.query(`update wallets set balance_minor = balance_minor + $1, updated_at = now() where user_id = $2`, [
        preHoldMinor,
        userId,
      ]);
      await client.query(
        `insert into ledger_entries (user_id, delta_minor, currency, reason, metadata)
         values ($1, $2, 'RUB', 'openrouter_refund_on_error', $3::jsonb)`,
        [userId, preHoldMinor, JSON.stringify({ model })],
      );
      await client.query(
        `insert into usage_logs (user_id, model, prompt_tokens, completion_tokens, total_tokens, cost_minor, prehold_minor, settlement_delta_minor, latency_ms, raw_response, error_text)
         values ($1, $2, 0, 0, 0, 0, $3, $4, 0, '{}'::jsonb, $5)`,
        [userId, model, preHoldMinor, preHoldMinor, String(error.message || error)],
      );
    });

    return res.status(500).json({ error: String(error.message || error) });
  }
});
