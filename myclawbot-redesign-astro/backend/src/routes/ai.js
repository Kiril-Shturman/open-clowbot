import { Router } from 'express';
import { z } from 'zod';
import { query } from '../db.js';
import { openRouterChat } from '../services/openrouter.js';
import { calcCostMinor, getModelPricing, getPreHoldMinor } from '../services/pricing.js';

export const aiRouter = Router();

const chatSchema = z.object({
  userId: z.string().uuid(),
  model: z.string().min(1),
  messages: z.array(z.object({ role: z.string(), content: z.string() })).min(1),
});

aiRouter.post('/chat', async (req, res) => {
  const parsed = chatSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  const { userId, model, messages } = parsed.data;
  const preHoldMinor = getPreHoldMinor();

  await query('begin');
  try {
    await query(
      `insert into wallets (user_id, balance_minor, currency) values ($1, 0, 'RUB')
       on conflict (user_id) do nothing`,
      [userId],
    );

    const wallet = await query(`select balance_minor from wallets where user_id = $1 for update`, [userId]);
    const balance = Number(wallet.rows[0]?.balance_minor || 0);

    if (balance < preHoldMinor) {
      await query('rollback');
      return res.status(402).json({ error: 'insufficient_balance', requiredMinor: preHoldMinor, balanceMinor: balance });
    }

    await query(`update wallets set balance_minor = balance_minor - $1, updated_at = now() where user_id = $2`, [
      preHoldMinor,
      userId,
    ]);
    await query(
      `insert into ledger_entries (user_id, delta_minor, currency, reason, metadata)
       values ($1, $2, 'RUB', 'openrouter_prehold', $3::jsonb)`,
      [userId, -preHoldMinor, JSON.stringify({ model })],
    );

    await query('commit');
  } catch (e) {
    await query('rollback');
    return res.status(500).json({ error: String(e.message || e) });
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

    await query('begin');
    if (settlementDeltaMinor !== 0) {
      await query(`update wallets set balance_minor = balance_minor + $1, updated_at = now() where user_id = $2`, [
        settlementDeltaMinor,
        userId,
      ]);
      await query(
        `insert into ledger_entries (user_id, delta_minor, currency, reason, metadata)
         values ($1, $2, 'RUB', 'openrouter_settlement', $3::jsonb)`,
        [userId, settlementDeltaMinor, JSON.stringify({ model, realCostMinor, preHoldMinor })],
      );
    }

    await query(
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

    await query('commit');
    res.json(response);
  } catch (error) {
    await query('begin');
    await query(`update wallets set balance_minor = balance_minor + $1, updated_at = now() where user_id = $2`, [
      preHoldMinor,
      userId,
    ]);
    await query(
      `insert into ledger_entries (user_id, delta_minor, currency, reason, metadata)
       values ($1, $2, 'RUB', 'openrouter_refund_on_error', $3::jsonb)`,
      [userId, preHoldMinor, JSON.stringify({ model })],
    );
    await query(
      `insert into usage_logs (user_id, model, prompt_tokens, completion_tokens, total_tokens, cost_minor, prehold_minor, settlement_delta_minor, latency_ms, raw_response, error_text)
       values ($1, $2, 0, 0, 0, 0, $3, $4, 0, '{}'::jsonb, $5)`,
      [userId, model, preHoldMinor, preHoldMinor, String(error.message || error)],
    );
    await query('commit');
    res.status(500).json({ error: String(error.message || error) });
  }
});
