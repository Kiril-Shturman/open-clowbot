export async function createHostkeyServer({ userId, plan, region, image = 'ubuntu-22.04' }) {
  const apiKey = process.env.HOSTKEY_API_KEY;
  if (!apiKey) throw new Error('HOSTKEY_API_KEY is not configured');

  const baseUrl = process.env.HOSTKEY_BASE_URL;
  if (!baseUrl) {
    return {
      externalServerId: `hk_${Date.now()}`,
      status: 'provisioning',
      ip: null,
      metadata: { mocked: true, userId, plan, region, image },
    };
  }

  const response = await fetch(`${baseUrl.replace(/\/$/, '')}/servers`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ plan, region, image, label: `myclawbot-${userId}` }),
  });

  const payload = await response.json();
  if (!response.ok) {
    throw new Error(`Hostkey create server failed: ${response.status} ${JSON.stringify(payload)}`);
  }

  return {
    externalServerId: payload.id || payload.server_id,
    status: payload.status || 'provisioning',
    ip: payload.ip || null,
    metadata: payload,
  };
}
