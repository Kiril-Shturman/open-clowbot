import 'dotenv/config';
import { query } from '../db.js';
import { getHostkeyServer } from '../services/hostkey.js';

const POLL_MS = Number(process.env.HOSTKEY_SYNC_POLL_MS || 30000);

async function tick() {
  const rows = await query(
    `select id, provider_server_id, status
     from servers
     where provider = 'hostkey'
       and status in ('provisioning', 'ready', 'stopped', 'error')
     order by updated_at asc
     limit 50`,
  );

  for (const server of rows.rows) {
    try {
      if (!server.provider_server_id) continue;
      // eslint-disable-next-line no-await-in-loop
      const remote = await getHostkeyServer(server.provider_server_id);

      // eslint-disable-next-line no-await-in-loop
      await query(
        `update servers
         set status = $2,
             ip_address = coalesce($3, ip_address),
             metadata = coalesce(metadata, '{}'::jsonb) || $4::jsonb,
             updated_at = now()
         where id = $1`,
        [server.id, remote.status, remote.ip, JSON.stringify({ hostkey: remote.metadata })],
      );

      if (remote.status !== server.status) {
        // eslint-disable-next-line no-await-in-loop
        await query(
          `insert into server_events (server_id, event_type, payload)
           values ($1, 'status_synced', $2::jsonb)`,
          [server.id, JSON.stringify({ from: server.status, to: remote.status })],
        );
      }
    } catch (error) {
      // eslint-disable-next-line no-await-in-loop
      await query(
        `insert into server_events (server_id, event_type, payload)
         values ($1, 'sync_failed', $2::jsonb)`,
        [server.id, JSON.stringify({ error: String(error.message || error) })],
      );
    }
  }
}

async function loop() {
  while (true) {
    await tick();
    await new Promise((r) => setTimeout(r, POLL_MS));
  }
}

console.log('Hostkey sync worker started');
loop();
