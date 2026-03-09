import { Router } from 'express';
import { z } from 'zod';
import { query } from '../db.js';
import { createHostkeyServer } from '../services/hostkey.js';
import { encryptSecret } from '../services/crypto.js';

export const infraRouter = Router();

const orderSchema = z.object({
  userId: z.string().uuid(),
  plan: z.string().min(1),
  region: z.string().min(1),
  botToken: z.string().min(10),
});

infraRouter.post('/servers/order', async (req, res) => {
  const parsed = orderSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  const { userId, plan, region, botToken } = parsed.data;
  try {
    const remote = await createHostkeyServer({ userId, plan, region });

    const serverRow = await query(
      `insert into servers (user_id, provider, provider_server_id, plan_code, region, status, ip_address, metadata)
       values ($1, 'hostkey', $2, $3, $4, $5, $6, $7::jsonb)
       returning id`,
      [userId, remote.externalServerId, plan, region, remote.status, remote.ip, JSON.stringify(remote.metadata || {})],
    );

    await query(
      `insert into bot_instances (user_id, server_id, telegram_bot_token_enc, status)
       values ($1, $2, $3, 'pending_deploy')`,
      [userId, serverRow.rows[0].id, encryptSecret(botToken)],
    );

    await query(
      `insert into server_events (server_id, event_type, payload)
       values ($1, 'order_created', $2::jsonb)`,
      [serverRow.rows[0].id, JSON.stringify({ plan, region })],
    );

    res.json({ ok: true, serverId: serverRow.rows[0].id, providerServerId: remote.externalServerId });
  } catch (error) {
    res.status(500).json({ error: String(error.message || error) });
  }
});

infraRouter.get('/servers/:userId', async (req, res) => {
  const rows = await query(`select * from servers where user_id = $1 order by created_at desc`, [req.params.userId]);
  res.json({ servers: rows.rows });
});
