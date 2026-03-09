import { Router } from 'express';
import { z } from 'zod';
import { query } from '../db.js';
import { createHostkeyServer, deleteHostkeyServer, getHostkeyServer, rebootHostkeyServer } from '../services/hostkey.js';
import { encryptSecret } from '../services/crypto.js';
import { enforceUserScope } from '../middleware/auth.js';

export const infraRouter = Router();

const orderSchema = z.object({
  userId: z.string().uuid(),
  plan: z.string().min(1),
  region: z.string().min(1),
  botToken: z.string().min(10),
});

async function logServerEvent(serverId, eventType, payload = {}) {
  await query(`insert into server_events (server_id, event_type, payload) values ($1, $2, $3::jsonb)`, [
    serverId,
    eventType,
    JSON.stringify(payload),
  ]);
}

infraRouter.post('/servers/order', enforceUserScope, async (req, res) => {
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

    await logServerEvent(serverRow.rows[0].id, 'order_created', { plan, region, providerServerId: remote.externalServerId });

    res.json({ ok: true, serverId: serverRow.rows[0].id, providerServerId: remote.externalServerId });
  } catch (error) {
    res.status(500).json({ error: String(error.message || error) });
  }
});

infraRouter.post('/servers/:serverId/sync', async (req, res) => {
  const { serverId } = req.params;

  const row = await query(`select id, provider_server_id, status from servers where id = $1 limit 1`, [serverId]);
  const server = row.rows[0];
  if (!server) return res.status(404).json({ error: 'server_not_found' });
  if (!server.provider_server_id) return res.status(400).json({ error: 'provider_server_id_missing' });

  try {
    const remote = await getHostkeyServer(server.provider_server_id);

    await query(
      `update servers set status = $2, ip_address = coalesce($3, ip_address), metadata = coalesce(metadata, '{}'::jsonb) || $4::jsonb, updated_at = now() where id = $1`,
      [server.id, remote.status, remote.ip, JSON.stringify({ hostkey: remote.metadata })],
    );

    if (server.status !== remote.status) {
      await logServerEvent(server.id, 'status_synced', { from: server.status, to: remote.status });
    }

    return res.json({ ok: true, status: remote.status, ip: remote.ip });
  } catch (error) {
    await logServerEvent(server.id, 'sync_failed', { error: String(error.message || error) });
    return res.status(502).json({ error: String(error.message || error) });
  }
});

infraRouter.post('/servers/:serverId/reboot', async (req, res) => {
  const { serverId } = req.params;
  const row = await query(`select id, provider_server_id from servers where id = $1 limit 1`, [serverId]);
  const server = row.rows[0];
  if (!server) return res.status(404).json({ error: 'server_not_found' });

  try {
    const remote = await rebootHostkeyServer(server.provider_server_id);
    await query(
      `update servers set status = $2, metadata = coalesce(metadata, '{}'::jsonb) || $3::jsonb, updated_at = now() where id = $1`,
      [server.id, remote.status, JSON.stringify({ lastAction: 'reboot', hostkey: remote.metadata })],
    );
    await logServerEvent(server.id, 'reboot_requested', { providerServerId: server.provider_server_id });
    return res.json({ ok: true, status: remote.status });
  } catch (error) {
    await logServerEvent(server.id, 'reboot_failed', { error: String(error.message || error) });
    return res.status(502).json({ error: String(error.message || error) });
  }
});

infraRouter.delete('/servers/:serverId', async (req, res) => {
  const { serverId } = req.params;
  const row = await query(`select id, provider_server_id from servers where id = $1 limit 1`, [serverId]);
  const server = row.rows[0];
  if (!server) return res.status(404).json({ error: 'server_not_found' });

  try {
    const remote = await deleteHostkeyServer(server.provider_server_id);
    await query(
      `update servers set status = 'deleted', metadata = coalesce(metadata, '{}'::jsonb) || $2::jsonb, updated_at = now() where id = $1`,
      [server.id, JSON.stringify({ lastAction: 'delete', hostkey: remote.metadata })],
    );
    await logServerEvent(server.id, 'server_deleted', { providerServerId: server.provider_server_id });
    return res.json({ ok: true });
  } catch (error) {
    await logServerEvent(server.id, 'delete_failed', { error: String(error.message || error) });
    return res.status(502).json({ error: String(error.message || error) });
  }
});

infraRouter.get('/servers/:userId', enforceUserScope, async (req, res) => {
  const rows = await query(`select * from servers where user_id = $1 order by created_at desc`, [req.params.userId]);
  res.json({ servers: rows.rows });
});
