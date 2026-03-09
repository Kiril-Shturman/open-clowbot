import { Router } from 'express';
import { z } from 'zod';
import { query } from '../db.js';
import { openRouterChat } from '../services/openrouter.js';

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

  const wallet = await query(`select balance_minor from wallets where user_id = $1`, [userId]);
  const balance = wallet.rows[0]?.balance_minor ?? 0;

  // Simplified guard: min 10 RUB before request.
  if (balance < 1000) {
    return res.status(402).json({ error: 'insufficient_balance', requiredMinor: 1000, balanceMinor: balance });
  }

  try {
    const startedAt = Date.now();
    const response = await openRouterChat({ model, messages });
    const elapsedMs = Date.now() - startedAt;

    const usage = response.usage || {};
    const promptTokens = Number(usage.prompt_tokens || 0);
    const completionTokens = Number(usage.completion_tokens || 0);
    const totalTokens = Number(usage.total_tokens || promptTokens + completionTokens);

    // Temporary flat pricing: 0.01 RUB / token.
    const costMinor = Math.ceil(totalTokens);

    await query('begin');
    await query(`update wallets set balance_minor = balance_minor - $1 where user_id = $2`, [costMinor, userId]);
    await query(
      `insert into ledger_entries (user_id, delta_minor, currency, reason, metadata)
       values ($1, $2, 'RUB', 'openrouter_usage', $3::jsonb)`,
      [userId, -costMinor, JSON.stringify({ model, totalTokens })],
    );
    await query(
      `insert into usage_logs (user_id, model, prompt_tokens, completion_tokens, total_tokens, cost_minor, latency_ms, raw_response)
       values ($1, $2, $3, $4, $5, $6, $7, $8::jsonb)`,
      [userId, model, promptTokens, completionTokens, totalTokens, costMinor, elapsedMs, JSON.stringify(response)],
    );
    await query('commit');

    res.json(response);
  } catch (error) {
    await query(
      `insert into usage_logs (user_id, model, prompt_tokens, completion_tokens, total_tokens, cost_minor, latency_ms, raw_response, error_text)
       values ($1, $2, 0, 0, 0, 0, 0, '{}'::jsonb, $3)`,
      [userId, model, String(error.message || error)],
    );
    res.status(500).json({ error: String(error.message || error) });
  }
});
