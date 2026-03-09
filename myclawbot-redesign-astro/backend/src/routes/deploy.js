import { Router } from 'express';
import { z } from 'zod';
import { query } from '../db.js';

export const deployRouter = Router();

const enqueueSchema = z.object({
  serverId: z.string().uuid(),
  userId: z.string().uuid(),
});

deployRouter.post('/enqueue', async (req, res) => {
  const parsed = enqueueSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  const { serverId, userId } = parsed.data;

  const row = await query(
    `insert into deploy_jobs (server_id, user_id, status, payload)
     values ($1, $2, 'queued', '{}'::jsonb)
     returning id`,
    [serverId, userId],
  );

  await query(`insert into server_events (server_id, event_type, payload) values ($1, 'deploy_queued', '{}'::jsonb)`, [
    serverId,
  ]);

  res.json({ ok: true, deployJobId: row.rows[0].id });
});

deployRouter.get('/jobs/:userId', async (req, res) => {
  const rows = await query(
    `select * from deploy_jobs where user_id = $1 order by created_at desc limit 50`,
    [req.params.userId],
  );
  res.json({ jobs: rows.rows });
});
