import 'dotenv/config';
import { exec as cpExec } from 'child_process';
import { promisify } from 'util';
import { decryptSecret } from '../services/crypto.js';
import { withTransaction, query } from '../db.js';

const exec = promisify(cpExec);
const POLL_MS = Number(process.env.DEPLOY_WORKER_POLL_MS || 5000);
const SSH_TIMEOUT_MS = Number(process.env.DEPLOY_SSH_TIMEOUT_MS || 1000 * 60 * 20);
const RETRY_DELAY_MS = Number(process.env.DEPLOY_RETRY_DELAY_MS || 30000);
const HEALTHCHECK_PATH = process.env.DEPLOY_HEALTHCHECK_PATH || '/health';
const HEALTHCHECK_TIMEOUT_MS = Number(process.env.DEPLOY_HEALTHCHECK_TIMEOUT_MS || 15000);

function escapeSingleQuotes(str) {
  return String(str).replace(/'/g, `'\\''`);
}

function buildSecrets(serverBotToken) {
  const secrets = {
    TELEGRAM_BOT_TOKEN: serverBotToken,
    OPENROUTER_API_KEY: process.env.OPENROUTER_API_KEY || '',
    YOOKASSA_SHOP_ID: process.env.YOOKASSA_SHOP_ID || '',
    YOOKASSA_SECRET_KEY: process.env.YOOKASSA_SECRET_KEY || '',
    YOOKASSA_WEBHOOK_SECRET: process.env.YOOKASSA_WEBHOOK_SECRET || '',
  };

  return Object.entries(secrets)
    .filter(([, v]) => v)
    .map(([k, v]) => `${k}=${String(v).replace(/\n/g, '')}`)
    .join('\n');
}

async function runRemoteDeploy({ ip, botToken }) {
  const sshUser = process.env.DEPLOY_SSH_USER || 'root';
  const scriptPath = process.env.DEPLOY_SCRIPT_PATH || '/opt/myclawbot/install-openclaw.sh';
  const remoteSecretsFile = process.env.DEPLOY_REMOTE_SECRETS_FILE || '/tmp/myclawbot-secrets.env';

  const secretsText = buildSecrets(botToken);
  const secretsBase64 = Buffer.from(secretsText, 'utf8').toString('base64');

  const remoteCmd = [
    `umask 077`,
    `echo '${escapeSingleQuotes(secretsBase64)}' | base64 -d > ${remoteSecretsFile}`,
    `MYCLAWBOT_SECRETS_FILE=${remoteSecretsFile} bash ${scriptPath}`,
    `rm -f ${remoteSecretsFile}`,
  ].join(' && ');

  const command = `ssh -o StrictHostKeyChecking=no ${sshUser}@${ip} '${remoteCmd}'`;
  const result = await exec(command, { timeout: SSH_TIMEOUT_MS });
  return `${result.stdout || ''}\n${result.stderr || ''}`;
}

async function runHealthcheck(ip) {
  const url = `http://${ip}${HEALTHCHECK_PATH}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(HEALTHCHECK_TIMEOUT_MS) });
  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`healthcheck_failed ${res.status}: ${txt.slice(0, 200)}`);
  }
}

async function processNext() {
  let job;

  try {
    job = await withTransaction(async (client) => {
      const next = await client.query(
        `select dj.id, dj.server_id, dj.user_id, dj.attempts, dj.max_attempts, s.ip_address
         from deploy_jobs dj
         join servers s on s.id = dj.server_id
         where dj.status in ('queued', 'retrying')
           and dj.next_retry_at <= now()
         order by dj.created_at asc
         limit 1
         for update skip locked`,
      );

      if (!next.rows.length) return null;

      const candidate = next.rows[0];
      await client.query(
        `update deploy_jobs
         set status = 'running', attempts = attempts + 1, updated_at = now()
         where id = $1`,
        [candidate.id],
      );

      return { ...candidate, attempts: Number(candidate.attempts || 0) + 1 };
    });

    if (!job) return;

    if (!job.ip_address) {
      throw new Error('server_has_no_ip');
    }

    const bot = await query(
      `select telegram_bot_token_enc
       from bot_instances
       where server_id = $1 and user_id = $2
       order by created_at desc
       limit 1`,
      [job.server_id, job.user_id],
    );

    const tokenEnc = bot.rows[0]?.telegram_bot_token_enc;
    if (!tokenEnc) {
      throw new Error('bot_token_missing_for_server');
    }

    const botToken = decryptSecret(tokenEnc);

    const logs = await runRemoteDeploy({ ip: job.ip_address, botToken });
    await runHealthcheck(job.ip_address);

    await withTransaction(async (client) => {
      await client.query(
        `update deploy_jobs
         set status = 'done', logs = $2, last_error = null, updated_at = now()
         where id = $1`,
        [job.id, logs.slice(0, 50000)],
      );
      await client.query(`update servers set status = 'ready', updated_at = now() where id = $1`, [job.server_id]);
      await client.query(
        `insert into server_events (server_id, event_type, payload)
         values ($1, 'deploy_done', $2::jsonb)`,
        [job.server_id, JSON.stringify({ jobId: job.id, attempts: job.attempts })],
      );
    });
  } catch (error) {
    if (!job) {
      console.error('deploy-worker error before job lock:', error);
      return;
    }

    const errText = String(error.message || error);
    const shouldRetry = Number(job.attempts || 1) < Number(job.max_attempts || 3);
    const delayMs = RETRY_DELAY_MS * Number(job.attempts || 1);

    await withTransaction(async (client) => {
      if (shouldRetry) {
        await client.query(
          `update deploy_jobs
           set status = 'retrying',
               last_error = $2,
               next_retry_at = now() + ($3 || ' milliseconds')::interval,
               updated_at = now()
           where id = $1`,
          [job.id, errText, String(delayMs)],
        );
        await client.query(`update servers set status = 'provisioning', updated_at = now() where id = $1`, [job.server_id]);
        await client.query(
          `insert into server_events (server_id, event_type, payload)
           values ($1, 'deploy_retry_scheduled', $2::jsonb)`,
          [job.server_id, JSON.stringify({ jobId: job.id, attempt: job.attempts, error: errText })],
        );
      } else {
        await client.query(
          `update deploy_jobs
           set status = 'failed',
               last_error = $2,
               updated_at = now()
           where id = $1`,
          [job.id, errText],
        );
        await client.query(`update servers set status = 'error', updated_at = now() where id = $1`, [job.server_id]);
        await client.query(
          `insert into server_events (server_id, event_type, payload)
           values ($1, 'deploy_failed', $2::jsonb)`,
          [job.server_id, JSON.stringify({ jobId: job.id, attempts: job.attempts, error: errText })],
        );
      }
    });
  }
}

async function loop() {
  while (true) {
    await processNext();
    await new Promise((r) => setTimeout(r, POLL_MS));
  }
}

console.log('Deploy worker started');
loop();
