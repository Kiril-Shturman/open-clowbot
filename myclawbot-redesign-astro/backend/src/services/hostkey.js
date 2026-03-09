const DEFAULT_TIMEOUT_MS = Number(process.env.HOSTKEY_TIMEOUT_MS || 15000);
const RETRIES = Number(process.env.HOSTKEY_RETRIES || 2);

function hasRealHostkey() {
  return Boolean(process.env.HOSTKEY_API_KEY && process.env.HOSTKEY_BASE_URL);
}

function base() {
  return String(process.env.HOSTKEY_BASE_URL || '').replace(/\/$/, '');
}

function headers() {
  const apiKey = process.env.HOSTKEY_API_KEY;
  if (!apiKey) throw new Error('HOSTKEY_API_KEY is not configured');
  return {
    Authorization: `Bearer ${apiKey}`,
    'Content-Type': 'application/json',
  };
}

async function request(path, { method = 'GET', body } = {}) {
  const url = `${base()}${path}`;
  let lastErr;

  for (let i = 0; i <= RETRIES; i += 1) {
    try {
      const res = await fetch(url, {
        method,
        headers: headers(),
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(DEFAULT_TIMEOUT_MS),
      });

      const text = await res.text();
      let payload = {};
      try {
        payload = text ? JSON.parse(text) : {};
      } catch {
        payload = { raw: text };
      }

      if (!res.ok) {
        const err = new Error(`Hostkey API ${method} ${path} failed: ${res.status}`);
        err.status = res.status;
        err.payload = payload;
        throw err;
      }

      return payload;
    } catch (e) {
      lastErr = e;
      const retryable = !e.status || e.status >= 500;
      if (i < RETRIES && retryable) continue;
      break;
    }
  }

  throw lastErr;
}

function normalizeStatus(raw) {
  const s = String(raw || '').toLowerCase();
  if (['running', 'active', 'started', 'ready'].includes(s)) return 'ready';
  if (['provisioning', 'creating', 'installing', 'starting', 'rebooting'].includes(s)) return 'provisioning';
  if (['stopped', 'off', 'shutdown'].includes(s)) return 'stopped';
  if (['deleted', 'terminated'].includes(s)) return 'deleted';
  if (['failed', 'error'].includes(s)) return 'error';
  return s || 'unknown';
}

function parseServer(payload) {
  const id = payload?.id || payload?.server_id || payload?.server?.id || payload?.server?.server_id;
  const statusRaw = payload?.status || payload?.state || payload?.server?.status || payload?.server?.state;
  const ip = payload?.ip || payload?.ip_address || payload?.server?.ip || payload?.server?.ip_address || null;

  return {
    externalServerId: id,
    status: normalizeStatus(statusRaw),
    ip,
    metadata: payload,
  };
}

export async function createHostkeyServer({ userId, plan, region, image = 'ubuntu-22.04' }) {
  if (!hasRealHostkey()) {
    return {
      externalServerId: `hk_${Date.now()}`,
      status: 'provisioning',
      ip: null,
      metadata: { mocked: true, userId, plan, region, image },
    };
  }

  const payload = await request('/servers', {
    method: 'POST',
    body: { plan, region, image, label: `myclawbot-${userId}` },
  });

  return parseServer(payload);
}

export async function getHostkeyServer(externalServerId) {
  if (!hasRealHostkey()) {
    return { externalServerId, status: 'provisioning', ip: null, metadata: { mocked: true } };
  }
  const payload = await request(`/servers/${encodeURIComponent(externalServerId)}`);
  return parseServer(payload);
}

export async function rebootHostkeyServer(externalServerId) {
  if (!hasRealHostkey()) {
    return { externalServerId, status: 'provisioning', ip: null, metadata: { mocked: true, action: 'reboot' } };
  }

  const payload = await request(`/servers/${encodeURIComponent(externalServerId)}/reboot`, {
    method: 'POST',
    body: {},
  });
  return parseServer(payload);
}

export async function deleteHostkeyServer(externalServerId) {
  if (!hasRealHostkey()) {
    return { externalServerId, status: 'deleted', ip: null, metadata: { mocked: true, action: 'delete' } };
  }

  const payload = await request(`/servers/${encodeURIComponent(externalServerId)}`, { method: 'DELETE' });
  return parseServer({ ...payload, status: payload?.status || 'deleted' });
}
