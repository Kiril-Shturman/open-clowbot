import 'dotenv/config';
import { query } from '../db.js';
import { exec as cpExec } from 'child_process';
import { promisify } from 'util';

const exec = promisify(cpExec);
const POLL_MS = Number(process.env.DEPLOY_WORKER_POLL_MS || 5000);

async function processNext() {
  await query('begin');
  try {
    const next = await query(
      `select dj.id, dj.server_id, dj.user_id, s.ip_address
       from deploy_jobs dj
       join servers s on s.id = dj.server_id
       where dj.status = 'queued'
       order by dj.created_at asc
       limit 1
       for update skip locked`,
    );

    if (!next.rows.length) {
      await query('commit');
      return;
    }

    const job = next.rows[0];
    await query(`update deploy_jobs set status = 'running', updated_at = now() where id = $1`, [job.id]);
    await query('commit');

    let logs = '';
    try {
      if (!job.ip_address) {
        throw new Error('Server has no IP yet; retry later');
      }

      const sshUser = process.env.DEPLOY_SSH_USER || 'root';
      const scriptPath = process.env.DEPLOY_SCRIPT_PATH || '/opt/myclawbot/install-openclaw.sh';
      const command = `ssh -o StrictHostKeyChecking=no ${sshUser}@${job.ip_address} 'bash ${scriptPath}'`;
      const result = await exec(command, { timeout: 1000 * 60 * 20 });
      logs = `${result.stdout || ''}\n${result.stderr || ''}`;

      await query('begin');
      await query(`update deploy_jobs set status = 'done', logs = $2, updated_at = now() where id = $1`, [job.id, logs]);
      await query(`update servers set status = 'ready', updated_at = now() where id = $1`, [job.server_id]);
      await query(
        `insert into server_events (server_id, event_type, payload) values ($1, 'deploy_done', $2::jsonb)`,
        [job.server_id, JSON.stringify({ jobId: job.id })],
      );
      await query('commit');
    } catch (error) {
      logs = `${logs}\nERROR: ${String(error.message || error)}`;
      await query('begin');
      await query(`update deploy_jobs set status = 'failed', logs = $2, updated_at = now() where id = $1`, [job.id, logs]);
      await query(`update servers set status = 'error', updated_at = now() where id = $1`, [job.server_id]);
      await query(
        `insert into server_events (server_id, event_type, payload) values ($1, 'deploy_failed', $2::jsonb)`,
        [job.server_id, JSON.stringify({ jobId: job.id, error: String(error.message || error) })],
      );
      await query('commit');
    }
  } catch (e) {
    await query('rollback');
    console.error('deploy-worker error:', e);
  }
}

async function loop() {
  // eslint-disable-next-line no-constant-condition
  while (true) {
    await processNext();
    await new Promise((r) => setTimeout(r, POLL_MS));
  }
}

console.log('Deploy worker started');
loop();
